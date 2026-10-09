// Attendance — hajari (API.md §3 Attendance).
//
// A day resolves through vw_attendance_days: a hand mark wins; otherwise
// running a machine that day makes a person present (half only if every slip
// flags them half); a stitch-based slip never counts. Only hand marks are
// written here. Clearing is soft; only "clear this month" carries a batch,
// so only it lands in the recycle bin as one item.

import type { AttendanceDay, AttendanceStatus, HajariDay, Month, StaffCategory, StaffHajari } from '@stitchflow/contract';
import { monthRange } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError, invalid, notFound } from '../http/errors.ts';
import type { Member } from '../http/types.ts';
import { PERSON_JSON } from './shapes.ts';

/** Longest range one person's days are read over: a year and a day. */
const MAX_RANGE_DAYS = 366;

/** Every active person with their resolved day; unmarked is status null. */
export function day(tx: Tx, member: Member, date: string, category?: StaffCategory): Promise<StaffHajari[]> {
  return tx.rows<StaffHajari>(
    `select ${PERSON_JSON} as staff,
            json_build_object('date', $1::date, 'status', d.status,
                              'fromProduction', coalesce(d.from_production, false)) as day
     from staff s
     left join vw_attendance_days d on d.staff_id = s.id and d.work_date = $1::date
     where s.deleted_at is null and s.is_active and ($2::text is null or s.category = $2)
       and (not $3::boolean or s.id = $4::bigint)
     order by s.name, s.id`,
    [date, category ?? null, member.role === 'worker', member.staffId],
  );
}

/** Every date of the month, counted across the active people; nothing at all with no one active. */
export async function daily(tx: Tx, month: Month): Promise<Record<string, AttendanceDay>> {
  const { start, end } = monthRange(month);
  const rows = await tx.rows<AttendanceDay & { date: string }>(
    `select to_char(g.on_date, 'YYYY-MM-DD') as date,
            count(*) filter (where d.status = 'present')::int as present,
            count(*) filter (where d.status = 'halfDay')::int as "halfDay",
            count(*) filter (where d.status = 'absent')::int as absent,
            count(*) filter (where d.status is null)::int as unmarked
     from generate_series($1::date, $2::date - 1, interval '1 day') g(on_date)
     cross join staff s
     left join (select staff_id, work_date, status from vw_attendance_days
                where work_date >= $1::date and work_date < $2::date) d
       on d.staff_id = s.id and d.work_date = g.on_date::date
     where s.deleted_at is null and s.is_active
     group by g.on_date
     order by g.on_date`,
    [start, end],
  );
  return Object.fromEntries(rows.map(({ date, ...counts }) => [date, counts]));
}

/** One person's every date in [from, to], both inclusive. A worker may read only their own. */
export async function forStaff(tx: Tx, member: Member, staffId: number, from: string, to: string): Promise<HajariDay[]> {
  if (member.role === 'worker' && member.staffId !== staffId) {
    throw new ApiError('forbidden', 'An operator sees only their own attendance.', { action: 'attendance.view' });
  }
  const span = await tx.one<{ days: number }>(`select $2::date - $1::date + 1 as days`, [from, to]);
  if (span!.days < 1 || span!.days > MAX_RANGE_DAYS) {
    throw invalid({ to: 'range' }, `to must be on or after from, at most ${MAX_RANGE_DAYS} days.`);
  }
  await requirePeople(tx, [staffId]);
  return tx.rows<HajariDay>(
    `select to_char(g.on_date, 'YYYY-MM-DD') as date, d.status,
            coalesce(d.from_production, false) as "fromProduction"
     from generate_series($2::date, $3::date, interval '1 day') g(on_date)
     left join vw_attendance_days d on d.staff_id = $1 and d.work_date = g.on_date::date
     order by g.on_date`,
    [staffId, from, to],
  );
}

/**
 * Refuses unless every id is a live person in this property, and — for a
 * half day — one allowed half days. The app never offers half a day to such
 * a person; the server holds the same line, as it holds the pay.
 */
async function requirePeople(tx: Tx, ids: number[], status?: AttendanceStatus): Promise<void> {
  const rows = await tx.rows<{ id: number; allowHalfDay: boolean }>(
    `select id, allow_half_day as "allowHalfDay" from staff where id = any($1::bigint[]) and deleted_at is null`,
    [ids],
  );
  if (rows.length !== new Set(ids).size) throw notFound('No such person.');
  const refused = rows.filter((r) => !r.allowHalfDay).map((r) => r.id);
  if (status === 'halfDay' && refused.length) {
    throw new ApiError('validation_failed', 'Half days are not allowed for this person.', {
      fields: { status: 'halfDayNotAllowed' }, staffIds: refused,
    });
  }
}

/**
 * Upserts hand marks for each person on each date. A row cleared earlier is
 * revived (staff and date are unique, deleted rows included) and leaves the
 * batch it was cleared in, so restoring that clear later cannot overwrite
 * what was chosen since.
 */
async function upsertMarks(tx: Tx, member: Member, staffIds: number[], dates: string[], status: AttendanceStatus) {
  if (!staffIds.length || !dates.length) return;
  await requirePeople(tx, staffIds, status);
  await tx.exec(
    `insert into attendance_marks (property_id, staff_id, work_date, status, created_by_member_id, updated_by_member_id)
     select $1, s, d, $4, $5, $5
     from (select distinct unnest($2::bigint[])) ids(s), (select distinct unnest($3::date[])) days(d)
     on conflict (staff_id, work_date) do update
       set status = excluded.status, deleted_at = null, deleted_by_member_id = null, deleted_batch = null,
           updated_by_member_id = excluded.updated_by_member_id`,
    [member.propertyId, staffIds, dates, status, member.memberId],
  );
}

export const mark = (tx: Tx, member: Member, staffId: number, date: string, status: AttendanceStatus) =>
  upsertMarks(tx, member, [staffId], [date], status);

/** Fills in many dates for one person. */
export const markMany = (tx: Tx, member: Member, staffId: number, dates: string[], status: AttendanceStatus) =>
  upsertMarks(tx, member, [staffId], dates, status);

/** Marks many people on one date — "mark the rest present". */
export const markAll = (tx: Tx, member: Member, staffIds: number[], date: string, status: AttendanceStatus) =>
  upsertMarks(tx, member, staffIds, [date], status);

/** A day back to unmarked: hidden, with no batch, so not in the bin. */
export async function unmark(tx: Tx, member: Member, staffId: number, date: string): Promise<void> {
  await requirePeople(tx, [staffId]);
  await tx.exec(
    `update attendance_marks set deleted_at = now(), deleted_by_member_id = $3, updated_by_member_id = $3
     where staff_id = $1 and work_date = $2 and deleted_at is null`,
    [staffId, date, member.memberId],
  );
}

/**
 * Undoes "mark the rest present": clears those people's live marks on that
 * date, as the app's clearAll does. An undo, not a deletion — no batch.
 */
export async function undoMarkAll(tx: Tx, member: Member, staffIds: number[], date: string): Promise<void> {
  if (!staffIds.length) return;
  await tx.exec(
    `update attendance_marks set deleted_at = now(), deleted_by_member_id = $3, updated_by_member_id = $3
     where staff_id = any($1::bigint[]) and work_date = $2 and deleted_at is null`,
    [staffIds, date, member.memberId],
  );
}

export interface ClearedMonth {
  staffId: number;
  month: Month;
  marks: { id: number; date: string; status: AttendanceStatus }[];
}

/** Clears a person's live marks in a month under one batch: one item in the bin. Returns what was cleared. */
export async function clearMonth(tx: Tx, member: Member, staffId: number, month: Month): Promise<ClearedMonth> {
  await requirePeople(tx, [staffId]);
  const { start, end } = monthRange(month);
  const marks = await tx.rows<ClearedMonth['marks'][number]>(
    `with batch as (select gen_random_uuid() as id)
     update attendance_marks k
     set deleted_at = now(), deleted_by_member_id = $4, updated_by_member_id = $4, deleted_batch = batch.id
     from batch
     where k.staff_id = $1 and k.work_date >= $2 and k.work_date < $3 and k.deleted_at is null
     returning k.id, to_char(k.work_date, 'YYYY-MM-DD') as date, k.status`,
    [staffId, start, end, member.memberId],
  );
  marks.sort((a, b) => a.date.localeCompare(b.date));
  return { staffId, month, marks };
}
