// Production: slips, their operators, totals and report scans (API.md §3
// Production). One slip per machine, date and shift; the server works out
// the bonus on save, so what the app sent is only ever a preview.

import { addDays, monthRange, roundMoney } from '@stitchflow/contract';
import type {
  CreatedId, DateOnly, EntryDraft, EntryPage, EntryWithKarigars, MachineDay, Month, ProductionEntry,
  ProductionTotals, ScanInput,
} from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { invalid, notFound } from '../http/errors.ts';
import type { Member } from '../http/types.ts';
import { calculateEntryBonus } from '../domain/bonus.ts';
import * as bonusRules from './bonusRules.ts';
import * as machines from './machines.ts';
import { getSettings, PERSON_JSON } from './shapes.ts';

/**
 * A slip with its operators and each one's share of the bonus, split equally
 * and rounded to the paisa. Filter on `e`.
 */
const ENTRY_SELECT = `
  select e.id, e.machine_id as "machineId", e.work_date as "workDate", e.shift_id as "shiftId",
         e.total_stitches as "totalStitches", e.emb_minutes as "embMinutes", e.stop_minutes as "stopMinutes",
         e.thread_breaks as "threadBreaks", e.frames, e.design_no as "designNo", e.design_name as "designName",
         e.design_stitches as "designStitches", e.has_head_loss as "hasHeadLoss",
         e.is_stitch_based as "isStitchBased", e.bonus_amount as "bonusAmount",
         e.bonus_is_manual as "bonusIsManual", e.note, e.slip_photo_file_id as "slipPhotoFileId",
         e.created_at as "createdAt", e.updated_at as "updatedAt",
         k.karigars, k.per_karigar as "bonusPerKarigar"
  from production_entries e
  cross join lateral (
    select coalesce(json_agg(json_build_object('staff', ${PERSON_JSON}, 'isHalfDay', ek.is_half_day)
                             order by s.name, s.id), '[]'::json) as karigars,
           case when count(*) = 0 then 0 else round(e.bonus_amount / count(*), 2) end as per_karigar
    from entry_karigars ek join staff s on s.id = ek.staff_id
    where ek.entry_id = e.id
  ) k`;

type EntryRow = ProductionEntry & Omit<EntryWithKarigars, 'entry'>;

const shape = ({ karigars, bonusPerKarigar, ...entry }: EntryRow): EntryWithKarigars =>
  ({ entry, karigars, bonusPerKarigar });

async function getById(tx: Tx, id: number): Promise<EntryWithKarigars> {
  const row = await tx.one<EntryRow>(`${ENTRY_SELECT} where e.id = $1 and e.deleted_at is null`, [id]);
  if (!row) throw notFound('No such slip.');
  return shape(row);
}

export async function find(tx: Tx, machineId: number, date: DateOnly, shiftId: number): Promise<EntryWithKarigars> {
  const row = await tx.one<EntryRow>(
    `${ENTRY_SELECT}
     where e.machine_id = $1 and e.work_date = $2 and e.shift_id = $3 and e.deleted_at is null`,
    [machineId, date, shiftId],
  );
  if (!row) throw notFound('Nothing recorded for that machine and shift.');
  return shape(row);
}

/** Every live, active machine by number, with its slip for the date and shift or null. */
export async function day(tx: Tx, date: DateOnly, shiftId: number): Promise<MachineDay[]> {
  const live = await machines.list(tx, true);
  const rows = await tx.rows<EntryRow>(
    `${ENTRY_SELECT} where e.work_date = $1 and e.shift_id = $2 and e.deleted_at is null`, [date, shiftId]);
  const byMachine = new Map(rows.map((r) => [r.machineId, shape(r)]));
  return live.map((machine) => ({ machine, entry: byMachine.get(machine.id) ?? null }));
}

/** Refuses a slip the floor could not have recorded, naming every bad field at once. */
async function checkDraft(tx: Tx, draft: EntryDraft): Promise<void> {
  const fields: Record<string, string> = {};
  const facts = await tx.one<{ machineLive: boolean; shiftMinutes: number | null; scanFits: boolean }>(
    `select exists (select 1 from machines m where m.id = $1 and m.deleted_at is null) as "machineLive",
            (select sh.duration_minutes from shifts sh
             where sh.id = $2 and sh.effective_from <= $3::date
               and (sh.effective_to is null or $3::date < sh.effective_to)) as "shiftMinutes",
            exists (select 1 from slip_scans x where x.id = $4 and x.machine_id = $1) as "scanFits"`,
    [draft.machineId, draft.shiftId, draft.workDate, draft.scanId ?? null],
  );
  if (!facts!.machineLive) fields.machineId = 'notFound';
  if (facts!.shiftMinutes === null) fields.shiftId = 'notInEffect';
  else if (draft.embMinutes + draft.stopMinutes > facts!.shiftMinutes) {
    fields.embMinutes = fields.stopMinutes = 'overShift';
  }
  if (draft.scanId != null && !facts!.scanFits) fields.scanId = 'notFound';

  const ids = draft.karigars.map((k) => k.staffId);
  const karigars = await tx.rows<{ id: number }>(
    `select s.id from staff s where s.id = any($1::bigint[]) and s.deleted_at is null and s.category = 'karigar'`,
    [ids],
  );
  const ok = new Set(karigars.map((s) => s.id));
  ids.forEach((id, i) => {
    if (!ok.has(id)) fields[`karigars[${i}].staffId`] = 'notKarigar';
  });
  if (new Set(ids).size !== ids.length) fields.karigars = 'duplicate';

  if (Object.keys(fields).length) throw invalid(fields, 'The slip cannot be saved as it is.');
}

/**
 * Typing a bonus by hand is setting someone's pay, so only a member who may
 * see pay can do it (the app shows the field only to them). Anyone else's
 * save keeps a hand-typed bonus already on the slip, or gets the rules' figure.
 */
async function withPermittedBonus(tx: Tx, member: Member, draft: EntryDraft): Promise<EntryDraft> {
  const r = await tx.one<{ can: boolean }>(`select fn_member_can($1, 'payroll.view') as can`, [member.memberId]);
  if (r!.can) return draft;
  const kept = await tx.one<{ amount: number }>(
    `select bonus_amount as amount from production_entries
     where machine_id = $1 and work_date = $2 and shift_id = $3 and deleted_at is null and bonus_is_manual`,
    [draft.machineId, draft.workDate, draft.shiftId],
  );
  return kept
    ? { ...draft, bonusIsManual: true, bonusAmount: kept.amount }
    : { ...draft, bonusIsManual: false };
}

/** The bonus to store: the hand-typed figure, or what the unit's rules and settings pay. */
async function bonusFor(tx: Tx, member: Member, draft: EntryDraft): Promise<number> {
  if (draft.bonusIsManual) return roundMoney(draft.bonusAmount);
  const rules = await bonusRules.list(tx);
  const settings = await getSettings(tx, member.propertyId);
  return calculateEntryBonus({
    stitches: draft.totalStitches,
    frames: draft.frames,
    hasHeadLoss: draft.hasHeadLoss,
    isStitchBased: draft.isStitchBased,
  }, rules, settings).amount;
}

/** Columns a save overwrites, in the order of the insert's values $2..$18. */
const SAVED = [
  'machine_id', 'work_date', 'shift_id', 'total_stitches', 'emb_minutes', 'stop_minutes', 'thread_breaks',
  'frames', 'design_no', 'design_name', 'design_stitches', 'has_head_loss', 'is_stitch_based', 'bonus_amount',
  'bonus_is_manual', 'note', 'slip_photo_file_id',
];

/**
 * Upserts the slip for its machine, date and shift. The unique key counts
 * deleted rows, so a slip in the bin for the slot is brought back and
 * overwritten rather than destroyed — destroying it would empty the bin
 * behind the user's back.
 */
export async function save(tx: Tx, member: Member, given: EntryDraft): Promise<EntryWithKarigars> {
  await checkDraft(tx, given);
  const draft = await withPermittedBonus(tx, member, given);
  const bonus = await bonusFor(tx, member, draft);
  const row = await tx.one<{ id: number }>(
    `insert into production_entries (property_id, ${SAVED.join(', ')}, created_by_member_id, updated_by_member_id)
     values ($1, ${SAVED.map((_, i) => `$${i + 2}`).join(', ')}, $19, $19)
     on conflict (machine_id, work_date, shift_id) do update set
       ${SAVED.slice(3).map((c) => `${c} = excluded.${c}`).join(', ')},
       updated_by_member_id = excluded.updated_by_member_id,
       deleted_at = null, deleted_by_member_id = null, deleted_batch = null
     returning id`,
    [
      member.propertyId, draft.machineId, draft.workDate, draft.shiftId, draft.totalStitches, draft.embMinutes,
      draft.stopMinutes, draft.threadBreaks, draft.frames, draft.designNo ?? null, draft.designName ?? null,
      draft.designStitches ?? null, draft.hasHeadLoss, draft.isStitchBased, bonus, draft.bonusIsManual,
      draft.note ?? null, draft.slipPhotoFileId ?? null, member.memberId,
    ],
  );
  const id = row!.id;
  await tx.exec(`delete from entry_karigars where entry_id = $1`, [id]);
  await tx.exec(
    `insert into entry_karigars (property_id, entry_id, staff_id, is_half_day)
     select $1, $2, s, h from unnest($3::bigint[], $4::boolean[]) as k(s, h)`,
    [member.propertyId, id, draft.karigars.map((k) => k.staffId), draft.karigars.map((k) => k.isHalfDay)],
  );
  if (draft.scanId != null) await tx.exec(`update slip_scans set entry_id = $1 where id = $2`, [id, draft.scanId]);
  return getById(tx, id);
}

/** Soft delete. Returns the slip as it was. */
export async function remove(tx: Tx, member: Member, id: number): Promise<EntryWithKarigars> {
  const before = await getById(tx, id);
  await tx.exec(
    `update production_entries set deleted_at = now(), deleted_by_member_id = $2, deleted_batch = gen_random_uuid()
     where id = $1 and deleted_at is null`,
    [id, member.memberId],
  );
  return before;
}

export interface EntryQuery {
  from: DateOnly;
  to: DateOnly;
  shiftId?: number;
  staffId?: number;
  limit?: number;
  cursor?: string;
}

// The cursor is the last row's sort key, opaque to the client.
const encodeCursor = (date: DateOnly, id: number) => Buffer.from(JSON.stringify([date, id])).toString('base64url');

function decodeCursor(cursor: string): [DateOnly, number] {
  try {
    const [date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isSafeInteger(id)) return [date, id];
  } catch { /* falls through */ }
  throw invalid({ cursor: 'invalid' }, 'Bad cursor.');
}

/** Slips from `from` to `to` inclusive, newest first, a page at a time. */
export async function page(tx: Tx, q: EntryQuery): Promise<EntryPage> {
  const limit = q.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid({ limit: 'range' }, 'limit is 1 to 500.');
  const [afterDate, afterId] = q.cursor ? decodeCursor(q.cursor) : [null, null];
  const rows = await tx.rows<EntryRow>(
    `${ENTRY_SELECT}
     where e.deleted_at is null and e.work_date between $1 and $2
       and ($3::bigint is null or e.shift_id = $3)
       and ($4::bigint is null or exists (select 1 from entry_karigars x where x.entry_id = e.id and x.staff_id = $4))
       and ($5::date is null or (e.work_date, e.id) < ($5::date, $6::bigint))
     order by e.work_date desc, e.id desc
     limit $7`,
    [q.from, q.to, q.shiftId ?? null, q.staffId ?? null, afterDate, afterId, limit + 1],
  );
  const items = rows.slice(0, limit).map(shape);
  const last = items.at(-1)?.entry;
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.workDate, last.id) : null };
}

/**
 * Sums over live slips in [$1, $2), optionally one shift, per day or overall.
 * Each slip is measured against its own shift version's length, as it was
 * timed the day it ran. Utilisation is emb time over that, not over emb +
 * stop: time nobody accounted for is idle, and idle is what it exposes.
 */
const totalsSql = (byDay: boolean) => `
  with sums as (
    select ${byDay ? 'e.work_date as day,' : ''}
           coalesce(sum(e.total_stitches), 0)::bigint as stitches,
           coalesce(sum(e.emb_minutes), 0)::bigint as emb,
           coalesce(sum(e.stop_minutes), 0)::bigint as stop,
           coalesce(sum(e.thread_breaks), 0)::bigint as breaks,
           coalesce(sum(e.frames), 0)::bigint as frames,
           count(*)::int as entries,
           count(distinct e.machine_id)::int as machines,
           coalesce(sum(sh.duration_minutes), 0)::bigint as shift
    from production_entries e
    join shifts sh on sh.id = e.shift_id
    where e.deleted_at is null and e.work_date >= $1 and e.work_date < $2
      and ($3::bigint is null or e.shift_id = $3)
    ${byDay ? 'group by e.work_date' : ''}
  )
  select ${byDay ? 'day,' : ''} stitches, emb as "embMinutes", stop as "stopMinutes", breaks as "threadBreaks",
         frames, entries as "entryCount", machines as "machineCount", shift as "shiftMinutes",
         case when shift > 0 then least(1, emb::numeric / shift) end as utilisation,
         case when shift > 0 then least(1, (emb + stop)::numeric / shift) end as "accountedFor",
         case when entries > 0 then round(stitches::numeric / entries) else 0 end as "averagePerEntry"
  from sums`;

/** Totals from `from` to `to` inclusive. */
export async function totals(tx: Tx, from: DateOnly, to: DateOnly, shiftId?: number): Promise<ProductionTotals> {
  const row = await tx.one<ProductionTotals>(totalsSql(false), [from, addDays(to, 1), shiftId ?? null]);
  return row!;
}

/** A month's totals per day; days with nothing recorded are absent. */
export async function dailyTotals(tx: Tx, month: Month, shiftId?: number): Promise<Record<DateOnly, ProductionTotals>> {
  const { start, end } = monthRange(month);
  const rows = await tx.rows<ProductionTotals & { day: DateOnly }>(totalsSql(true), [start, end, shiftId ?? null]);
  return Object.fromEntries(rows.map(({ day: d, ...t }) => [d, t]));
}

/** Keeps what a report photo was read as, to tune the reader against real machine screens. */
export async function recordScan(tx: Tx, member: Member, input: ScanInput): Promise<CreatedId> {
  const facts = await tx.one<{ machineLive: boolean; photoExists: boolean }>(
    `select exists (select 1 from machines m where m.id = $1 and m.deleted_at is null) as "machineLive",
            exists (select 1 from files f where f.id = $2) as "photoExists"`,
    [input.machineId, input.photoFileId],
  );
  const fields: Record<string, string> = {};
  if (!facts!.machineLive) fields.machineId = 'notFound';
  if (!facts!.photoExists) fields.photoFileId = 'notFound';
  if (Object.keys(fields).length) throw invalid(fields, 'The scan cannot be kept as it is.');
  const row = await tx.one<CreatedId>(
    `insert into slip_scans (property_id, machine_id, photo_file_id, engine, lines, reading, created_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [member.propertyId, input.machineId, input.photoFileId, input.engine, JSON.stringify(input.lines),
      JSON.stringify(input.reading), member.memberId],
  );
  return row!;
}
