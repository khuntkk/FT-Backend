// The recycle bin (API.md §3 Recycle bin), ported from LocalRecycleBinRepository
// and AppDatabase.purgeExpiredDeletions in sf_core.
//
// What is in the bin is vw_recycle_bin's business: a child deleted with its
// parent shares the parent's deleted_batch and is folded into it, a cleared
// month is one item named by its lowest id, and anything past
// fn_recovery_window() has dropped out. Every route here starts by finding
// its item in that view, so "not in the bin" is one 404 whatever the reason.

import type { ActionKey, DeletedItem, DeletedKind, RestoreProblem } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError, notFound, onConstraint } from '../http/errors.ts';
import type { Member } from '../http/types.ts';

const ITEM_COLUMNS = `
  kind, id, deleted_at as "deletedAt", deleted_at + fn_recovery_window() as "expiresAt",
  name, machine_number as "machineNumber", category, code, on_date as date,
  shift_name as "shiftName", stitches, pay_mode as "payMode", condition,
  bonus_kind as "bonusKind", amount, child_count as "childCount"`;

/** The table each kind lives in, for change notices. */
export const TABLE_OF: Record<DeletedKind, string> = {
  machine: 'machines', staff: 'staff', productionEntry: 'production_entries', upad: 'advances',
  salaryPayment: 'salary_payments', bonusRule: 'bonus_rules', attendance: 'attendance_marks',
};

/**
 * Everything inside the recovery window, newest deletion first. An advance's
 * or a payslip's amount is pay: it is left out for a member who may not see
 * advances or payroll (a unit can narrow an admin's modules).
 */
export function list(tx: Tx, member: Member): Promise<DeletedItem[]> {
  return tx.rows<DeletedItem>(
    `select ${ITEM_COLUMNS.replace('bonus_kind as "bonusKind", amount,', `bonus_kind as "bonusKind",
       case kind when 'upad' then case when fn_member_can($1, 'advances.view') then amount end
                 when 'salaryPayment' then case when fn_member_can($1, 'payroll.view') then amount end
                 else amount end as amount,`)}
     from vw_recycle_bin order by deleted_at desc, kind, id`,
    [member.memberId],
  );
}

/** Bringing back an advance or a payslip changes what someone is owed: it needs that module too. */
export const RESTORE_ALSO_NEEDS: Partial<Record<DeletedKind, ActionKey>> = {
  upad: 'advances.record',
  salaryPayment: 'payroll.mark_paid',
};

async function find(tx: Tx, kind: DeletedKind, id: number): Promise<DeletedItem> {
  const item = await tx.one<DeletedItem>(
    `select ${ITEM_COLUMNS} from vw_recycle_bin where kind = $1 and id = $2`, [kind, id]);
  if (!item) throw notFound('Not in the recycle bin.');
  return item;
}

const blocked = (problem: RestoreProblem, details: Record<string, unknown> = {}) =>
  new ApiError('restore_blocked', `Cannot restore: ${problem}.`, { problem, ...details });

// Brings rows back; $2 is always the member restoring them.
const CLEAR = `deleted_at = null, deleted_by_member_id = null, deleted_batch = null, updated_by_member_id = $2`;

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Puts an item back with exactly what went with it. Refuses, having changed
 * nothing, when that would leave a record nothing can reach or collide with
 * one added since. A machine past the limit is refused by the database
 * (constraint machine_limit → 409 machine_limit_reached).
 */
export async function restore(tx: Tx, member: Member, kind: DeletedKind, id: number): Promise<DeletedItem> {
  const item = await find(tx, kind, id);
  await RESTORE[kind](tx, member.memberId, id);
  return item;
}

const RESTORE: Record<DeletedKind, (tx: Tx, by: number, id: number) => Promise<void>> = {
  machine: restoreMachine,
  staff: restoreStaff,
  productionEntry: restoreEntry,
  upad: async (tx, by, id) => {
    const a = await tx.one<{ staffId: number }>(`select staff_id as "staffId" from advances where id = $1`, [id]);
    await requireLiveStaff(tx, a!.staffId);
    await tx.exec(`update advances set ${CLEAR} where id = $1`, [id, by]);
  },
  salaryPayment: restorePayslip,
  bonusRule: async (tx, by, id) => {
    await tx.exec(`update bonus_rules set ${CLEAR} where id = $1`, [id, by]);
  },
  attendance: async (tx, by, id) => {
    const mark = await tx.one<{ staffId: number; batch: string }>(
      `select staff_id as "staffId", deleted_batch as batch from attendance_marks where id = $1`, [id]);
    await requireLiveStaff(tx, mark!.staffId);
    // Days marked again since the clear left the batch when they were marked,
    // so this cannot overwrite a choice made afterwards.
    await tx.exec(`update attendance_marks set ${CLEAR} where deleted_batch = $1 and deleted_at is not null`,
      [mark!.batch, by]);
  },
};

async function restoreMachine(tx: Tx, by: number, id: number) {
  const m = await tx.one<{ number: number; name: string | null; batch: string | null }>(
    `select number, name, deleted_batch as batch from machines where id = $1`, [id]);
  const taken = () => blocked('machineNumberTaken', { name: m!.name, number: m!.number });
  // The number may have gone to a new machine in the meantime.
  const live = await tx.one(`select 1 from machines where number = $1 and deleted_at is null`, [m!.number]);
  if (live) throw taken();
  await onConstraint(tx.exec(`update machines set ${CLEAR} where id = $1`, [id, by]), 'machines_live_number', taken);
  if (m!.batch) {
    await tx.exec(`update production_entries set ${CLEAR} where deleted_batch = $1 and deleted_at is not null`,
      [m!.batch, by]);
  }
}

async function restoreStaff(tx: Tx, by: number, id: number) {
  const s = await tx.one<{ code: string | null; batch: string | null }>(
    `select code, deleted_batch as batch from staff where id = $1`, [id]);
  await onConstraint(tx.exec(`update staff set ${CLEAR} where id = $1`, [id, by]), 'staff_live_code',
    () => new ApiError('staff_code_taken', `Code ${s!.code} is taken.`, { code: s!.code }));
  if (!s!.batch) return;
  await tx.exec(`update advances set ${CLEAR} where deleted_batch = $1 and deleted_at is not null`, [s!.batch, by]);
  await onConstraint(
    tx.exec(`update salary_payments set ${CLEAR} where deleted_batch = $1 and deleted_at is not null`, [s!.batch, by]),
    'salary_payments_live_period', () => blocked('periodAlreadyPaid'));
}

// An entry deleted on its own before its machine went must wait for the
// machine: brought back alone it would count toward attendance and bonus
// while no screen could show it. Shifts are retired, never deleted, and a
// deleted operator's slips stay live anyway, so the machine is the only parent.
async function restoreEntry(tx: Tx, by: number, id: number) {
  const m = await tx.one<{ name: string | null; number: number; deleted: boolean }>(
    `select m.name, m.number, m.deleted_at is not null as deleted
     from production_entries e join machines m on m.id = e.machine_id where e.id = $1`, [id]);
  if (m!.deleted) throw blocked('parentDeleted', { name: m!.name, number: m!.number });
  await tx.exec(`update production_entries set ${CLEAR} where id = $1`, [id, by]);
}

async function restorePayslip(tx: Tx, by: number, id: number) {
  const p = await tx.one<{ staffId: number; paidAgain: boolean }>(
    `select p.staff_id as "staffId",
            exists (select 1 from salary_payments q where q.staff_id = p.staff_id
                    and q.period_start = p.period_start and q.deleted_at is null) as "paidAgain"
     from salary_payments p where p.id = $1`, [id]);
  await requireLiveStaff(tx, p!.staffId);
  if (p!.paidAgain) throw blocked('periodAlreadyPaid');
  await onConstraint(tx.exec(`update salary_payments set ${CLEAR} where id = $1`, [id, by]),
    'salary_payments_live_period', () => blocked('periodAlreadyPaid'));
}

/** A person's records come back with them, not before them. */
async function requireLiveStaff(tx: Tx, staffId: number) {
  const s = await tx.one<{ name: string }>(`select name from staff where id = $1 and deleted_at is not null`, [staffId]);
  if (s) throw blocked('parentDeleted', { name: s.name });
}

// ---------------------------------------------------------------------------
// Delete forever, empty, purge
// ---------------------------------------------------------------------------

/** Removes an item for good before its window is up. Returns it as it was. */
export async function deleteForever(tx: Tx, kind: DeletedKind, id: number): Promise<DeletedItem> {
  const item = await find(tx, kind, id);
  await FOREVER[kind](tx, id);
  return item;
}

// A deletion date already past the recovery window: takes a row out of the
// bin without removing it.
const BEYOND_WINDOW = `now() - fn_recovery_window() - interval '1 day'`;

const FOREVER: Record<DeletedKind, (tx: Tx, id: number) => Promise<unknown>> = {
  machine: machineForever,
  staff: staffForever,
  productionEntry: (tx, id) => tx.exec(`delete from production_entries where id = $1 and deleted_at is not null`, [id]),
  upad: (tx, id) => tx.exec(`delete from advances where id = $1 and deleted_at is not null`, [id]),
  salaryPayment: (tx, id) => tx.exec(`delete from salary_payments where id = $1 and deleted_at is not null`, [id]),
  bonusRule: (tx, id) => tx.exec(`delete from bonus_rules where id = $1 and deleted_at is not null`, [id]),
  attendance: (tx, id) => tx.exec(
    `delete from attendance_marks
     where deleted_at is not null
       and deleted_batch = (select deleted_batch from attendance_marks where id = $1)`, [id]),
};

// The machine's deleted slips go first: they could never come back without
// it (restore_blocked parentDeleted), and the foreign key is restrict so a
// purge cannot take a live slip by accident. A live slip on a deleted machine
// should not exist; if one does, the machine is kept out of sight instead.
async function machineForever(tx: Tx, id: number) {
  await tx.exec(`delete from production_entries where machine_id = $1 and deleted_at is not null`, [id]);
  const removed = await tx.exec(
    `delete from machines m where m.id = $1
       and not exists (select 1 from production_entries e where e.machine_id = m.id)`, [id]);
  if (!removed) await tx.exec(`update machines set deleted_at = ${BEYOND_WINDOW} where id = $1`, [id]);
}

// A person who ran machines is kept out of sight, not removed: entry_karigars
// restricts it, because removing them would hand their share of each slip's
// bonus to whoever else was on the machine. Their advances, payslips and
// marks go either way — that is what deleting them forever means.
async function staffForever(tx: Tx, id: number) {
  for (const table of ['advances', 'salary_payments', 'attendance_marks']) {
    await tx.exec(`delete from ${table} where staff_id = $1`, [id]);
  }
  const removed = await tx.exec(
    `delete from staff s where s.id = $1
       and not exists (select 1 from entry_karigars k where k.staff_id = s.id)`, [id]);
  if (!removed) await tx.exec(`update staff set deleted_at = ${BEYOND_WINDOW} where id = $1`, [id]);
}

// Children before parents, so a machine's or a person's own items are gone
// before the machine or person is looked at.
const EMPTY_ORDER: DeletedKind[] = ['attendance', 'upad', 'salaryPayment', 'productionEntry', 'bonusRule', 'staff', 'machine'];

/** Every item as delete-forever would take it. Returns what was in the bin. */
export async function empty(tx: Tx, member: Member): Promise<DeletedItem[]> {
  const items = await list(tx, member);
  const ordered = [...items].sort((a, b) => EMPTY_ORDER.indexOf(a.kind) - EMPTY_ORDER.indexOf(b.kind));
  for (const item of ordered) await FOREVER[item.kind](tx, item.id);
  return items;
}

/**
 * The daily purge: everything deleted longer ago than the recovery window,
 * across every property the transaction can see. Children before parents;
 * a machine anything still points at, and a person who ran machines, stay.
 * Uses rows/one only, so a test can run it over plain superuser SQL.
 */
export async function purgeExpired(tx: Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [table, extra] of PURGE) {
    const row = await tx.one<{ n: number }>(
      `with gone as (delete from ${table} t where t.deleted_at < now() - fn_recovery_window() ${extra} returning 1)
       select count(*)::int as n from gone`);
    counts[table] = row!.n;
  }
  return counts;
}

const PURGE: [string, string][] = [
  ['advances', ''],
  ['salary_payments', ''],
  ['attendance_marks', ''],
  ['production_entries', ''],
  ['machines', 'and not exists (select 1 from production_entries e where e.machine_id = t.id)'],
  ['staff', 'and not exists (select 1 from entry_karigars k where k.staff_id = t.id)'],
  ['bonus_rules', ''],
];
