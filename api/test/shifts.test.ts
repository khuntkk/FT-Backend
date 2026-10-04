// The shift cases of packages/sf_core/test/database_test.dart, as API tests.
// Where the apps saved a clashing set and offered Smart Adjust afterwards,
// the API refuses the change (409 shift_cycle_clash), so those cases arrange
// their overlap with SQL or reach the same end without passing through one.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addDays, todayIn } from '@stitchflow/contract';
import { planSmartAdjust, validateShiftCycle } from '../src/domain/shifts.ts';
import { seedProperty, signIn, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(() => h.close());

const today = () => todayIn('Asia/Kolkata');
const tomorrow = () => addDays(today(), 1);
/** A day in the past, before any change a test makes. */
const PAST = '2026-03-10';

interface Unit {
  p: SeededProperty;
  as: Client;
  dayShift: number;
  nightShift: number;
  machineId: number;
}

/** A fresh property with its seeded Day and Night, one machine, and its super admin signed in. */
async function fresh(): Promise<Unit> {
  const p = await seedProperty(h);
  const as = await signIn(h, p.members.superAdmin2.username);
  const [day, night] = (await as.get('/v1/shifts/current')).body;
  const [{ id: machineId }] = await h.sql(
    `insert into machines (property_id, number) values ($1, 1) returning id`, [p.propertyId]);
  return { p, as, dayShift: day.id, nightShift: night.id, machineId };
}

/** Records a slip; `deleted` puts it straight into the bin. */
async function slip(u: Unit, shiftId: number, workDate: string, opts: { deleted?: boolean; stitches?: number } = {}) {
  const [{ id }] = await h.sql(
    `insert into production_entries (property_id, machine_id, work_date, shift_id, total_stitches, deleted_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [u.p.propertyId, u.machineId, workDate, shiftId, opts.stitches ?? 100000, opts.deleted ? new Date() : null],
  );
  return id as number;
}

const rowCount = async (u: Unit) =>
  Number((await h.sql(`select count(*) as n from shifts where property_id = $1`, [u.p.propertyId]))[0].n);
const slipShift = async (id: number) =>
  Number((await h.sql(`select shift_id from production_entries where id = $1`, [id]))[0].shift_id);
const current = async (u: Unit) => (await u.as.get('/v1/shifts/current')).body as any[];
const editable = async (u: Unit) => (await u.as.get('/v1/shifts/editable')).body as any[];
const names = (xs: any[]) => xs.map((s) => s.name);
const starts = (xs: any[]) => xs.map((s) => s.startMinute);
const snapshot = (xs: any[]) =>
  xs.map(({ id, name, startMinute, durationMinutes }) => ({ id, name, startMinute, durationMinutes }));

describe('who may change the schedule', () => {
  it('every role reads; only a super admin changes, audited', async () => {
    const u = await fresh();
    for (const role of ['admin', 'viewAdmin', 'supervisor', 'worker'] as const) {
      const c = await signIn(h, u.p.members[role].username);
      const read = await c.get('/v1/shifts/current');
      assert.equal(read.status, 200, role);
      assert.deepEqual(names(read.body), ['Day', 'Night']);
      const refused = await c.patch(`/v1/shifts/${u.dayShift}`, { name: 'General' });
      assert.equal(refused.status, 403, role);
      if (role === 'admin') assert.equal(refused.body.error.code, 'super_admin_only');
    }

    const ok = await u.as.patch(`/v1/shifts/${u.dayShift}`, { name: 'General' });
    assert.equal(ok.status, 200);
    const [audit] = await h.sql(
      `select * from audit_log where property_id = $1 and action = 'shifts.change'`, [u.p.propertyId]);
    assert.equal(audit.destructive, true);
    assert.equal(audit.entity_type, 'shift');
    assert.equal(audit.entity_id, String(u.dayShift));
    assert.deepEqual(names(audit.before), ['Day', 'Night']);
    assert.deepEqual(names(audit.after), ['General', 'Night']);
  });
});

describe('shifts', () => {
  it('a fresh install runs Day and Night', async () => {
    const active = await current(await fresh());
    assert.deepEqual(names(active), ['Day', 'Night']);
    assert.deepEqual(validateShiftCycle(active), []);
  });

  it('switching to three shifts replaces the set and records the scheme', async () => {
    const u = await fresh();
    const res = await u.as.put('/v1/shifts/scheme', { scheme: 'threeShift', dayStartMinute: 480 });
    assert.equal(res.status, 200);
    assert.deepEqual(names(res.body), ['Morning', 'Evening', 'Night']);
    assert.equal((await current(u)).length, 3);
    assert.deepEqual(validateShiftCycle(res.body), []);
    const [settings] = await h.sql(
      `select shift_scheme, day_start_minute from property_settings where property_id = $1`, [u.p.propertyId]);
    assert.deepEqual(settings, { shift_scheme: 'threeShift', day_start_minute: 480 });
  });

  it('retired shifts are kept so old slips still name them', async () => {
    const u = await fresh();
    const entry = await slip(u, u.dayShift, PAST, { stitches: 120000 });
    await u.as.put('/v1/shifts/scheme', { scheme: 'threeShift', dayStartMinute: 480 });

    assert.equal((await current(u)).length, 3);
    const old = (await u.as.get(`/v1/shifts/${u.dayShift}`)).body;
    assert.equal(old.name, 'Day', 'the version it was recorded under');
    assert.notEqual(old.effectiveTo, null, 'closed, not rewritten');
    assert.equal(await slipShift(entry), u.dayShift);
  });

  it('switching back reuses the rows rather than duplicating', async () => {
    const u = await fresh();
    await u.as.put('/v1/shifts/scheme', { scheme: 'threeShift', dayStartMinute: 480 });
    await u.as.put('/v1/shifts/scheme', { scheme: 'dayNight', dayStartMinute: 480 });

    const active = await current(u);
    assert.deepEqual(names(active), ['Day', 'Night']);
    assert.equal(active[0].id, u.dayShift, 'the original row came back');
    assert.equal(active[0].effectiveTo, null, 'and is open again');
    assert.equal(await rowCount(u), 2, 'no version stacked up on the way');
  });

  it('three shifts can be re-anchored, and again, without rebuilding them', async () => {
    const u = await fresh();
    await u.as.put('/v1/shifts/scheme', { scheme: 'threeShift', dayStartMinute: 6 * 60 });
    const first = await current(u);
    assert.deepEqual(names(first), ['Morning', 'Evening', 'Night']);
    assert.deepEqual(starts(first), [6 * 60, 14 * 60, 22 * 60]);

    await u.as.put('/v1/shifts/scheme', { scheme: 'threeShift', dayStartMinute: 9 * 60 });
    const again = await current(u);
    assert.deepEqual(starts(again), [9 * 60, 17 * 60, 1 * 60]);
    assert.deepEqual(again.map((s) => s.lineageId), first.map((s) => s.lineageId), 'still three shifts, not six');
  });

  it('custom keeps whatever is already defined', async () => {
    const u = await fresh();
    await u.as.put('/v1/shifts/scheme', { scheme: 'threeShift', dayStartMinute: 480 });
    const res = await u.as.put('/v1/shifts/scheme', { scheme: 'manual', dayStartMinute: 480 });
    assert.deepEqual(names(res.body), ['Morning', 'Evening', 'Night']);
    const [settings] = await h.sql(`select shift_scheme from property_settings where property_id = $1`, [u.p.propertyId]);
    assert.equal(settings.shift_scheme, 'manual');
  });

  it('a custom cycle can start at any hour', async () => {
    const u = await fresh();
    await u.as.put('/v1/shifts/scheme', { scheme: 'manual', dayStartMinute: 480 });
    for (const s of await current(u)) assert.equal((await u.as.post(`/v1/shifts/${s.id}/retire`)).status, 204);
    assert.deepEqual(await current(u), []);

    for (const [name, start] of [['First', 15], ['Second', 23], ['Third', 7]] as const) {
      const res = await u.as.post('/v1/shifts', { name, startMinute: start * 60, durationMinutes: 8 * 60 });
      assert.equal(res.status, 200);
      assert.equal(res.body.lineageId, res.body.id, 'a first version is its own lineage');
    }
    const active = await current(u);
    assert.deepEqual(names(active), ['First', 'Second', 'Third']);
    assert.deepEqual(validateShiftCycle(active), []);
  });

  it('a shift can be renamed and re-timed', async () => {
    const u = await fresh();
    const res = await u.as.patch(`/v1/shifts/${u.dayShift}`,
      { name: 'General', startMinute: 9 * 60, durationMinutes: 9 * 60 });
    assert.equal(res.status, 200);
    assert.equal(res.body.effectiveFrom, today());

    const active = await current(u);
    assert.equal(active.length, 2, 'editing must never add a second shift to the cycle');
    assert.deepEqual(
      [active[0].name, active[0].startMinute, active[0].durationMinutes], ['General', 9 * 60, 9 * 60]);
  });

  it('editing opens a version and leaves the old one alone', async () => {
    const u = await fresh();
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { name: 'General', startMinute: 9 * 60, durationMinutes: 9 * 60 });

    const original = (await u.as.get(`/v1/shifts/${u.dayShift}`)).body;
    assert.equal(original.name, 'Day', 'the row is never rewritten');
    assert.equal(original.startMinute, 8 * 60);
    assert.equal(original.effectiveTo, today());

    const now = (await current(u))[0];
    assert.notEqual(now.id, u.dayShift);
    assert.equal(now.lineageId, original.lineageId, 'still recognisably the same shift');
  });

  it('a past date keeps the shifts that actually ran then', async () => {
    const u = await fresh();
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { name: 'General', startMinute: 9 * 60, durationMinutes: 9 * 60 });

    const back = (await u.as.get('/v1/shifts', { on: PAST })).body;
    assert.deepEqual(names(back), ['Day', 'Night']);
    assert.equal(back[0].startMinute, 8 * 60);
    assert.equal(back[0].id, u.dayShift, 'the version March was recorded under');
  });

  it('editing twice in a day leaves that day one version', async () => {
    const u = await fresh();
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 10 * 60 });
    await u.as.patch(`/v1/shifts/${(await current(u))[0].id}`, { durationMinutes: 11 * 60 });

    const lineage = (await current(u))[0].lineageId;
    const versions = await h.sql(`select id from shifts where lineage_id = $1`, [lineage]);
    assert.equal(versions.length, 2, "the original and today's");
    assert.equal((await current(u))[0].durationMinutes, 11 * 60);
    assert.equal((await u.as.get('/v1/shifts', { on: PAST })).body[0].durationMinutes, 12 * 60);
  });

  it('a slip recorded today pushes a change to tomorrow', async () => {
    const u = await fresh();
    const entry = await slip(u, u.dayShift, today());

    const earliest = await u.as.get('/v1/shifts/earliest-effective-date', { shiftIds: `${u.dayShift}` });
    assert.deepEqual(earliest.body, { date: tomorrow() }, "today's slips keep the shift they were recorded under");

    const res = await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 10 * 60 });
    assert.equal(res.body.effectiveFrom, tomorrow());
    assert.equal((await u.as.get('/v1/shifts', { on: today() })).body[0].durationMinutes, 12 * 60);
    assert.equal((await u.as.get('/v1/shifts', { on: tomorrow() })).body[0].durationMinutes, 10 * 60);
    assert.equal(await slipShift(entry), u.dayShift, 'the old slip keeps its old version');
    assert.equal((await u.as.get(`/v1/shifts/${u.dayShift}`)).body.effectiveTo, tomorrow());
  });

  it('creating adds exactly one shift', async () => {
    const u = await fresh();
    await u.as.patch(`/v1/shifts/${u.nightShift}`, { durationMinutes: 4 * 60 });
    const res = await u.as.post('/v1/shifts', { name: 'Extra', startMinute: 2 * 60, durationMinutes: 60 });
    assert.equal(res.status, 200);
    assert.equal(res.body.sortOrder, 2);
    assert.deepEqual(names(await current(u)), ['Day', 'Night', 'Extra']);
  });

  it('retiring drops it from the active set only', async () => {
    const u = await fresh();
    const res = await u.as.post(`/v1/shifts/${u.nightShift}/retire`);
    assert.equal(res.status, 204);
    assert.deepEqual(names(await current(u)), ['Day']);
    assert.equal((await u.as.get(`/v1/shifts/${u.nightShift}`)).status, 200);
  });

  it('a version a slip points at is never deleted, even with inconsistent data', async () => {
    const u = await fresh();
    const v2 = (await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 10 * 60 })).body;
    // Arranged by hand: a past slip on a version that starts today. Retiring
    // drops a version not yet in effect, but this one is pinned.
    await slip(u, v2.id, PAST);

    const res = await u.as.post(`/v1/shifts/${v2.id}/retire`);
    assert.equal(res.status, 204);
    assert.deepEqual(names(await current(u)), ['Night']);
    const kept = (await u.as.get(`/v1/shifts/${v2.id}`)).body;
    assert.equal(kept.effectiveTo, kept.effectiveFrom, 'kept as a range that never applied');
  });
});

describe('clashes', () => {
  it('an overlap is refused with its problems, and nothing changes', async () => {
    const u = await fresh();
    const rows = await rowCount(u);
    const res = await u.as.patch(`/v1/shifts/${u.nightShift}`, { startMinute: 10 * 60 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'shift_cycle_clash');
    assert.deepEqual(res.body.error.details.problems, [{ kind: 'overlap', shift: 'Day', other: 'Night' }]);
    assert.equal(await rowCount(u), rows);
    assert.deepEqual(starts(await current(u)), [8 * 60, 20 * 60]);
  });

  it('adding into a full day is refused', async () => {
    const u = await fresh();
    const res = await u.as.post('/v1/shifts', { name: 'Extra', startMinute: 2 * 60, durationMinutes: 60 });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details.problems, [
      { kind: 'totalOverDay', shift: null, other: null },
      { kind: 'overlap', shift: 'Night', other: 'Extra' },
    ]);
    assert.equal((await current(u)).length, 2);
  });

  it('a gap is not a clash', async () => {
    const u = await fresh();
    assert.equal((await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 4 * 60 })).status, 200);
    assert.equal((await u.as.patch(`/v1/shifts/${u.nightShift}`, { durationMinutes: 4 * 60 })).status, 200);
  });
});

describe('smart adjust applied', () => {
  /** A clashing custom cycle, arranged by hand: the API would refuse to save one. */
  async function overlapping(): Promise<Unit> {
    const u = await fresh();
    await h.sql(`update shifts set name = 'A', start_minute = 360, duration_minutes = 480 where id = $1`, [u.dayShift]);
    await h.sql(`update shifts set name = 'B', start_minute = 720, duration_minutes = 480 where id = $1`, [u.nightShift]);
    await h.sql(
      `insert into shifts (property_id, name, start_minute, duration_minutes, sort_order, effective_from)
       values ($1, 'C', 1080, 480, 2, '2026-01-01')`,
      [u.p.propertyId],
    );
    return u;
  }

  const timings = (plan: NonNullable<ReturnType<typeof planSmartAdjust>>) =>
    plan.shifts.map(({ id, startMinute, durationMinutes }) => ({ id, startMinute, durationMinutes }));

  it('applying the plan makes the cycle sound; twice changes nothing', async () => {
    const u = await overlapping();
    const plan = planSmartAdjust(await current(u));
    assert.ok(plan);

    const res = await u.as.put('/v1/shifts/timings', { shifts: timings(plan) });
    assert.equal(res.status, 200);
    const after = await current(u);
    assert.deepEqual(validateShiftCycle(after), []);
    assert.deepEqual(starts(after), [6 * 60, 14 * 60, 22 * 60]);
    assert.deepEqual(names(after), ['A', 'B', 'C'], 'order and names are preserved');
    assert.equal(planSmartAdjust(after), null, 'nothing left to fix');
  });

  it('re-timing does not disturb slips already recorded', async () => {
    const u = await overlapping();
    const entry = await slip(u, u.dayShift, PAST, { stitches: 90000 });
    await u.as.put('/v1/shifts/timings', { shifts: timings(planSmartAdjust(await current(u))!) });
    assert.equal(await slipShift(entry), u.dayShift);
  });

  it('timings that still clash are refused', async () => {
    const u = await overlapping();
    const res = await u.as.put('/v1/shifts/timings', {
      shifts: (await current(u)).map(({ id, startMinute, durationMinutes }) => ({ id, startMinute, durationMinutes })),
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'shift_cycle_clash');
  });
});

describe('restoring a shift set', () => {
  it('puts edited timings back, leaving no version behind', async () => {
    const u = await fresh();
    const before = snapshot(await current(u));
    const rows = await rowCount(u);
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 10 * 60 });

    const res = await u.as.put('/v1/shifts/restore', { shifts: before });
    assert.equal(res.status, 200);
    const after = await current(u);
    assert.deepEqual(snapshot(after), before);
    assert.equal(await rowCount(u), rows, 'a cancelled edit is not history');
  });

  it('retires a shift added after the snapshot, leaving no trace', async () => {
    const u = await fresh();
    await u.as.patch(`/v1/shifts/${u.nightShift}`, { durationMinutes: 4 * 60 });
    const good = snapshot(await editable(u));
    const rows = await rowCount(u);
    await u.as.post('/v1/shifts', { name: 'Extra', startMinute: 2 * 60, durationMinutes: 60 });
    assert.equal((await current(u)).length, 3);

    await u.as.put('/v1/shifts/restore', { shifts: good });
    assert.deepEqual(names(await current(u)), ['Day', 'Night']);
    assert.equal(await rowCount(u), rows);
  });

  it('brings back a shift removed after the snapshot', async () => {
    const u = await fresh();
    const before = snapshot(await current(u));
    await u.as.post(`/v1/shifts/${u.nightShift}/retire`);
    assert.equal((await current(u)).length, 1);

    await u.as.put('/v1/shifts/restore', { shifts: before });
    const after = await current(u);
    assert.equal(after.length, 2);
    assert.deepEqual(validateShiftCycle(after), []);
    assert.equal(after[1].id, u.nightShift, 'the same version, reopened');
  });

  it('an empty snapshot retires everything', async () => {
    const u = await fresh();
    assert.equal((await u.as.put('/v1/shifts/restore', { shifts: [] })).status, 200);
    assert.deepEqual(await current(u), []);
  });

  it('restoring leaves recorded production alone', async () => {
    const u = await fresh();
    const entry = await slip(u, u.dayShift, PAST, { stitches: 70000 });
    const before = snapshot(await current(u));
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 4 * 60 });
    await u.as.put('/v1/shifts/restore', { shifts: before });
    assert.equal(await slipShift(entry), u.dayShift);
  });

  it('keeps an earlier good edit from the same day', async () => {
    const u = await fresh();
    await u.as.put('/v1/shifts/timings', { shifts: [
      { id: u.dayShift, startMinute: 7 * 60, durationMinutes: 12 * 60 },
      { id: u.nightShift, startMinute: 19 * 60, durationMinutes: 12 * 60 },
    ] });
    const good = snapshot(await editable(u));

    const clash = await u.as.patch(`/v1/shifts/${good[1].id}`, { startMinute: 10 * 60 });
    assert.equal(clash.status, 409);

    await u.as.put('/v1/shifts/restore', { shifts: good });
    assert.deepEqual(starts(await editable(u)), [7 * 60, 19 * 60], "the morning's good edit is not the one undone");
  });
});

describe('shift changes waiting for tomorrow', () => {
  it('are what Settings shows and edits', async () => {
    const u = await fresh();
    await slip(u, u.dayShift, today());
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { startMinute: 9 * 60, durationMinutes: 11 * 60 });

    assert.equal((await current(u))[0].startMinute, 8 * 60, "today keeps the hours this morning's slip ran under");
    assert.equal((await editable(u))[0].startMinute, 9 * 60, 'the pending change is what the screen must show');
  });

  it('a second edit builds on the first rather than undoing it', async () => {
    const u = await fresh();
    await slip(u, u.dayShift, today());
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { startMinute: 9 * 60, durationMinutes: 11 * 60 });
    const pending = (await editable(u))[0];
    await u.as.patch(`/v1/shifts/${pending.id}`, { name: 'Morning' });

    const next = (await u.as.get('/v1/shifts', { on: tomorrow() })).body[0];
    assert.equal(next.name, 'Morning');
    assert.equal(next.startMinute, 9 * 60, 'renaming must not put back the old start time');
  });

  it('every edit joins the pending date', async () => {
    const u = await fresh();
    await slip(u, u.dayShift, today());
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 11 * 60 });

    const earliest = await u.as.get('/v1/shifts/earliest-effective-date', { shiftIds: `${u.nightShift}` });
    assert.equal(earliest.body.date, tomorrow(), 'Night has no slips today, but the set moves as one');
    await u.as.patch(`/v1/shifts/${u.nightShift}`, { durationMinutes: 11 * 60 });
    assert.equal((await current(u))[1].durationMinutes, 12 * 60);
  });

  it('a shift added now joins the pending set', async () => {
    const u = await fresh();
    await slip(u, u.dayShift, today());
    await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 8 * 60 });
    await u.as.post('/v1/shifts', { name: 'Evening', startMinute: 16 * 60, durationMinutes: 4 * 60 });

    assert.equal((await current(u)).length, 2, 'today, which nobody is checking any more, is untouched');
    assert.equal((await editable(u)).length, 3);
  });

  it('a slip in the bin still holds the day', async () => {
    const u = await fresh();
    await slip(u, u.dayShift, today(), { deleted: true });
    const earliest = await u.as.get('/v1/shifts/earliest-effective-date', { shiftIds: `${u.dayShift},${u.nightShift}` });
    assert.equal(earliest.body.date, tomorrow(), 'it can be restored, and must come back to its own shift');
  });

  it('a scheme switch with slips today waits for tomorrow', async () => {
    const u = await fresh();
    await slip(u, u.nightShift, today());
    const res = await u.as.put('/v1/shifts/scheme', { scheme: 'threeShift', dayStartMinute: 480 });
    assert.ok(res.body.every((s: any) => s.effectiveFrom === tomorrow()));
    assert.deepEqual(names(await current(u)), ['Day', 'Night']);
    assert.deepEqual(names(await editable(u)), ['Morning', 'Evening', 'Night']);
  });

  it('re-timing back and forth with a slip in the bin keeps the slip its shift', async () => {
    const u = await fresh();
    const v2 = (await u.as.patch(`/v1/shifts/${u.dayShift}`, { durationMinutes: 10 * 60 })).body;
    assert.equal(v2.effectiveFrom, today());
    const entry = await slip(u, v2.id, today(), { deleted: true });

    const back = await u.as.patch(`/v1/shifts/${v2.id}`, { durationMinutes: 12 * 60 });
    assert.equal(back.status, 200);
    assert.equal(back.body.effectiveFrom, tomorrow());

    await h.sql(`update production_entries set deleted_at = null where id = $1`, [entry]);
    const its = (await u.as.get(`/v1/shifts/${await slipShift(entry)}`)).body;
    assert.ok(its.effectiveFrom <= today() && (its.effectiveTo === null || its.effectiveTo > today()),
      'a restored slip must land in a shift that covers its day');
  });
});

describe('tenant isolation', () => {
  it("another property's shifts are not found and their slips do not count", async () => {
    const mine = await fresh();
    const theirs = await fresh();
    await slip(theirs, theirs.dayShift, today());

    assert.equal((await mine.as.get(`/v1/shifts/${theirs.dayShift}`)).status, 404);
    assert.equal((await mine.as.patch(`/v1/shifts/${theirs.dayShift}`, { name: 'X' })).status, 404);
    assert.equal((await mine.as.post(`/v1/shifts/${theirs.dayShift}/retire`)).status, 404);
    assert.equal((await mine.as.put('/v1/shifts/timings', {
      shifts: [{ id: theirs.dayShift, startMinute: 0, durationMinutes: 60 }],
    })).status, 404);
    assert.equal((await mine.as.put('/v1/shifts/restore', {
      shifts: [{ id: theirs.dayShift, name: 'X', startMinute: 0, durationMinutes: 60 }],
    })).status, 404);

    const earliest = await mine.as.get('/v1/shifts/earliest-effective-date', { shiftIds: `${theirs.dayShift}` });
    assert.equal(earliest.body.date, today());
    assert.deepEqual((await current(mine)).map((s) => s.id), [mine.dayShift, mine.nightShift]);
    assert.deepEqual(names(await current(theirs)), ['Day', 'Night'], 'untouched');
  });
});
