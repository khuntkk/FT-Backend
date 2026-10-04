// Shifts (API.md §3 Shifts), ported from LocalShiftRepository in the apps.
//
// A shift is never re-timed in place once anything may have run under it:
// a change closes the version in effect on a date and opens a new one from
// it, so a past slip always reads back with the hours it ran under. The
// database holds the one-version-per-day rule (shifts_one_version_per_day);
// this file decides the date a change takes effect and keeps lineages
// stable across arrangements.
//
// `today` is always the property's date, passed in by the handler.

import type {
  RestoreShiftsInput, SchemeInput, Shift, ShiftInput, ShiftPatch, ShiftTiming,
} from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { orderedCycle, presetShifts, shiftProblemMessage, validateShiftCycle } from '../domain/shifts.ts';
import { ApiError, notFound } from '../http/errors.ts';
import type { Member } from '../http/types.ts';

/** From shifts s. */
const SHIFT_COLUMNS = `
  s.id, s.lineage_id as "lineageId", s.name, s.start_minute as "startMinute",
  s.duration_minutes as "durationMinutes", s.sort_order as "sortOrder",
  s.effective_from as "effectiveFrom", s.effective_to as "effectiveTo"`;

/** A version's timings: what opening a version writes. */
interface Timing {
  name: string;
  startMinute: number;
  durationMinutes: number;
  sortOrder: number;
}

/** The versions in effect on a date, in running order. */
export async function on(tx: Tx, date: string): Promise<Shift[]> {
  const rows = await tx.rows<Shift>(
    `select ${SHIFT_COLUMNS} from shifts s
     where s.effective_from <= $1 and (s.effective_to is null or s.effective_to > $1)
     order by s.sort_order, s.id`,
    [date],
  );
  return orderedCycle(rows);
}

/** Any version, retired ones included. */
export async function get(tx: Tx, id: number): Promise<Shift> {
  const s = await tx.one<Shift>(`select ${SHIFT_COLUMNS} from shifts s where s.id = $1`, [id]);
  if (!s) throw notFound('No such shift.');
  return s;
}

/**
 * Today, or the furthest date a change is already waiting for — a version
 * opening then, or a shift leaving the cycle then.
 */
export async function pendingDate(tx: Tx, today: string): Promise<string> {
  const row = await tx.one<{ date: string }>(
    `select greatest($1::date, max(effective_from), max(effective_to)) as date from shifts`, [today]);
  return row!.date;
}

/** The set Settings shows and edits: tomorrow's once a change is waiting. */
export async function editable(tx: Tx, today: string): Promise<Shift[]> {
  return on(tx, await pendingDate(tx, today));
}

/**
 * When a change to these shifts can start. A version starting on a day that
 * already has slips against the shift would leave those slips pointing at a
 * version their own day no longer contains, so the answer is the day after
 * the last slip from today on — by lineage, so a slip on any version counts,
 * and with the bin included, because a slip deleted this morning can be
 * restored this afternoon. Never before a change already waiting.
 *
 * That guarantee is also what lets the versioning below drop or rewrite a
 * version starting on or after the answer: nothing can point at one.
 */
export async function earliestEffectiveDate(tx: Tx, today: string, shiftIds: number[]): Promise<string> {
  const row = await tx.one<{ date: string }>(
    `select greatest($1::date, max(s.effective_from), max(s.effective_to),
                     (select max(e.work_date) + 1
                      from production_entries e
                      join shifts v on v.id = e.shift_id
                      where e.work_date >= $1
                        and v.lineage_id in (select lineage_id from shifts where id = any($2::bigint[])))
           ) as date
     from shifts s`,
    [today, shiftIds],
  );
  return row!.date;
}

/** Refuses a set that would clash; an empty set is unfinished, not a clash. */
async function assertSound(tx: Tx, day: string): Promise<Shift[]> {
  const set = await on(tx, day);
  const problems = set.length ? validateShiftCycle(set) : [];
  if (problems.length) {
    throw new ApiError('shift_cycle_clash', problems.map(shiftProblemMessage).join(' '), { problems });
  }
  return set;
}

/**
 * Opens a version of a lineage from `day`. A shift edited twice before its
 * change takes effect has that day's version rewritten rather than a second
 * one stacked on it. If the result is identical to the version it supersedes,
 * the two merge back into one: switching a scheme away and back, or undoing
 * an edit, leaves no history behind. Returns the version now covering `day`.
 */
async function openVersion(tx: Tx, member: Member, lineageId: number, t: Timing, day: string): Promise<number> {
  const written = await writeVersion(tx, member, lineageId, t, day);
  const predecessor = await tx.one<{ id: number }>(
    `select id from shifts
     where lineage_id = $1 and id <> $2 and effective_from < $3 and effective_to = $3
       and name = $4 and start_minute = $5 and duration_minutes = $6
     limit 1`,
    [lineageId, written, day, t.name, t.startMinute, t.durationMinutes],
  );
  if (!predecessor) return written;
  // earliestEffectiveDate means no slip can point at a version from `day`;
  // the check here keeps a restricted reference from ever being the reason a
  // change fails, by keeping the version instead of merging.
  const dropped = await tx.exec(
    `delete from shifts s
     where s.id = $1 and s.id <> s.lineage_id
       and not exists (select 1 from production_entries e where e.shift_id = s.id)`,
    [written],
  );
  if (!dropped) return written;
  await tx.exec(
    `update shifts set sort_order = $2, effective_to = null, updated_by_member_id = $3 where id = $1`,
    [predecessor.id, t.sortOrder, member.memberId],
  );
  return predecessor.id;
}

/** Rewrites the version starting on `day`, or closes the open one and inserts a new one. */
async function writeVersion(tx: Tx, member: Member, lineageId: number, t: Timing, day: string): Promise<number> {
  const sameDay = await tx.one<{ id: number }>(
    `update shifts set name = $3, start_minute = $4, duration_minutes = $5, sort_order = $6,
                       effective_to = null, updated_by_member_id = $7
     where id = (select id from shifts where lineage_id = $1 and effective_from = $2 order by id desc limit 1)
     returning id`,
    [lineageId, day, t.name, t.startMinute, t.durationMinutes, t.sortOrder, member.memberId],
  );
  if (sameDay) return sameDay.id;
  await closeOpenVersions(tx, member, lineageId, day);
  const row = await tx.one<{ id: number }>(
    `insert into shifts (property_id, lineage_id, name, start_minute, duration_minutes, sort_order,
                         effective_from, created_by_member_id, updated_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
    [member.propertyId, lineageId, t.name, t.startMinute, t.durationMinutes, t.sortOrder, day, member.memberId],
  );
  return row!.id;
}

/** Ends every still-open version of a lineage that began before `day`. */
async function closeOpenVersions(tx: Tx, member: Member, lineageId: number, day: string): Promise<void> {
  await tx.exec(
    `update shifts set effective_to = $2, updated_by_member_id = $3
     where lineage_id = $1 and effective_to is null and effective_from < $2`,
    [lineageId, day, member.memberId],
  );
}

/**
 * Takes a lineage out of the cycle from `day`. A version that has not started
 * yet is a change not worth keeping, so it is dropped rather than closed — a
 * shift created and removed before it ran leaves no stub. Slips restrict
 * deleting a version; should one ever point at it, it is kept as an empty
 * range ([from, from): never applied) instead.
 */
async function retireLineage(tx: Tx, member: Member, lineageId: number, day: string): Promise<void> {
  await tx.exec(
    `delete from shifts s
     where s.lineage_id = $1 and s.effective_from >= $2
       and not exists (select 1 from production_entries e join shifts v on v.id = e.shift_id
                       where v.lineage_id = $1 and v.effective_from >= $2)`,
    [lineageId, day],
  );
  await tx.exec(
    `update shifts set effective_to = effective_from, updated_by_member_id = $3
     where lineage_id = $1 and effective_from >= $2 and effective_to is distinct from effective_from`,
    [lineageId, day, member.memberId],
  );
  await closeOpenVersions(tx, member, lineageId, day);
}

/** Inserts a shift with no history behind it; the trigger points its lineage at itself. */
async function insertLineage(tx: Tx, member: Member, t: Timing, day: string): Promise<number> {
  const row = await tx.one<{ id: number }>(
    `insert into shifts (property_id, name, start_minute, duration_minutes, sort_order, effective_from,
                         created_by_member_id, updated_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
    [member.propertyId, t.name, t.startMinute, t.durationMinutes, t.sortOrder, day, member.memberId],
  );
  return row!.id;
}

/**
 * Switches the arrangement and day start. Each preset slot re-times the shift
 * already holding it, so a unit keeps one "Day" lineage across every scheme
 * it ever runs; shifts the new scheme has no room for leave the cycle, their
 * versions keeping their hours for the slips recorded under them. Custom
 * keeps whatever is defined and only records the choice.
 */
export async function applyScheme(tx: Tx, member: Member, today: string, input: SchemeInput): Promise<Shift[]> {
  await tx.exec(
    `update property_settings set shift_scheme = $2, day_start_minute = $3 where property_id = $1`,
    [member.propertyId, input.scheme, input.dayStartMinute],
  );
  const preset = presetShifts(input.scheme, input.dayStartMinute);
  if (!preset.length) return editable(tx, today);

  const existing = await editable(tx, today);
  const day = await earliestEffectiveDate(tx, today, existing.map((s) => s.id));
  for (const s of existing.slice(preset.length)) await retireLineage(tx, member, s.lineageId, day);
  for (const [i, spec] of preset.entries()) {
    const t = { ...spec, sortOrder: i };
    if (i < existing.length) await openVersion(tx, member, existing[i].lineageId, t, day);
    else await insertLineage(tx, member, t, day);
  }
  return assertSound(tx, day);
}

/**
 * Adds a shift. It has no slips behind it, so it may start today — unless
 * other changes are waiting for a later date, in which case it joins them
 * rather than landing alone in today's set, which nobody is looking at.
 */
export async function create(tx: Tx, member: Member, today: string, input: ShiftInput): Promise<Shift> {
  const day = await pendingDate(tx, today);
  const sortOrder = input.sortOrder ?? (await on(tx, day)).length;
  const id = await insertLineage(tx, member, { ...input, sortOrder }, day);
  await assertSound(tx, day);
  return get(tx, id);
}

/** Opens a version of the shift from the earliest safe date; returns the version covering it. */
export async function update(tx: Tx, member: Member, today: string, id: number, patch: ShiftPatch): Promise<Shift> {
  const shift = await get(tx, id);
  const day = await earliestEffectiveDate(tx, today, [id]);
  const written = await openVersion(tx, member, shift.lineageId, {
    name: patch.name ?? shift.name,
    startMinute: patch.startMinute ?? shift.startMinute,
    durationMinutes: patch.durationMinutes ?? shift.durationMinutes,
    sortOrder: patch.sortOrder ?? shift.sortOrder,
  }, day);
  await assertSound(tx, day);
  return get(tx, written);
}

/**
 * Takes the shift out of the cycle from the earliest safe date. Not checked
 * for clashes: fewer shifts can only clash less.
 */
export async function retire(tx: Tx, member: Member, today: string, id: number): Promise<void> {
  const shift = await get(tx, id);
  const day = await earliestEffectiveDate(tx, today, [id]);
  await retireLineage(tx, member, shift.lineageId, day);
}

/** The shifts named, every one of them in this property. */
async function getAll(tx: Tx, ids: number[]): Promise<Shift[]> {
  const found = await tx.rows<Shift>(`select ${SHIFT_COLUMNS} from shifts s where s.id = any($1::bigint[])`, [ids]);
  const byId = new Map(found.map((s) => [s.id, s]));
  return ids.map((id) => {
    const s = byId.get(id);
    if (!s) throw notFound(`No such shift: ${id}.`);
    return s;
  });
}

/** Smart Adjust: new timings for several shifts, applied together, in the running order given. */
export async function applyTimings(tx: Tx, member: Member, today: string, timings: ShiftTiming[]): Promise<Shift[]> {
  if (!timings.length) return editable(tx, today);
  const shifts = await getAll(tx, timings.map((t) => t.id));
  const day = await earliestEffectiveDate(tx, today, timings.map((t) => t.id));
  for (const [i, t] of timings.entries()) {
    await openVersion(tx, member, shifts[i].lineageId, {
      name: shifts[i].name, startMinute: t.startMinute, durationMinutes: t.durationMinutes, sortOrder: i,
    }, day);
  }
  return assertSound(tx, day);
}

/**
 * Undo to a known-good set. Takes effect on the date the change being undone
 * did, found the same way. Anything in the set then that the snapshot lacks
 * was added since and leaves; everything it has gets exactly its timings — a
 * shift edited since gets a version that merges straight back into the one
 * before it, so an undone edit leaves no trace.
 */
export async function restore(tx: Tx, member: Member, today: string, input: RestoreShiftsInput): Promise<Shift[]> {
  const named = await getAll(tx, input.shifts.map((s) => s.id));
  const wanted = new Map<number, Timing>();
  input.shifts.forEach((s, i) => wanted.set(named[i].lineageId, {
    name: s.name, startMinute: s.startMinute, durationMinutes: s.durationMinutes, sortOrder: i,
  }));
  const showing = await editable(tx, today);
  const day = await earliestEffectiveDate(tx, today, [...showing.map((s) => s.id), ...named.map((s) => s.id)]);

  for (const s of await on(tx, day)) {
    if (!wanted.has(s.lineageId)) await retireLineage(tx, member, s.lineageId, day);
  }
  for (const [lineageId, t] of wanted) await openVersion(tx, member, lineageId, t, day);
  return assertSound(tx, day);
}
