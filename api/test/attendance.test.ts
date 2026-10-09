import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { seedProperty, signInAll, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;
let asha: number;
let bharat: number;
let chetan: number;
let gone: number;
let day: number;
let night: number;

async function person(name: string, extra: Record<string, unknown> = {}): Promise<number> {
  const cols = ['property_id', 'name', ...Object.keys(extra)];
  const [{ id }] = await h.sql(
    `insert into staff (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    [p.propertyId, name, ...Object.values(extra)],
  );
  return id;
}

/** A slip on machine `number` with its crew: [staffId, isHalfDay]. */
async function slip(number: number, date: string, shiftId: number, crew: [number, boolean][], stitchBased = false) {
  const [{ id: machineId }] = await h.sql(
    `insert into machines (property_id, number) values ($1, $2)
     on conflict (property_id, number) where deleted_at is null do update set name = machines.name returning id`,
    [p.propertyId, number],
  );
  const [{ id }] = await h.sql(
    `insert into production_entries (property_id, machine_id, work_date, shift_id, is_stitch_based)
     values ($1, $2, $3, $4, $5) returning id`,
    [p.propertyId, machineId, date, shiftId, stitchBased],
  );
  for (const [staffId, half] of crew) {
    await h.sql(`insert into entry_karigars (property_id, entry_id, staff_id, is_half_day) values ($1, $2, $3, $4)`,
      [p.propertyId, id, staffId, half]);
  }
  return id;
}

const binItems = () =>
  h.sql(`select * from vw_recycle_bin where property_id = $1 and kind = 'attendance'`, [p.propertyId]);

const days = async (c: Client, staffId: number, from: string, to: string) =>
  (await c.get(`/v1/staff/${staffId}/attendance`, { from, to })).body;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
  asha = await person('Asha');
  bharat = await person('Bharat', { allow_half_day: false });
  chetan = await person('Chetan', { category: 'otherStaff' });
  await person('Inactive', { is_active: false });
  gone = await person('Gone', { deleted_at: new Date() });
  [{ id: day }, { id: night }] = await h.sql(`select id from shifts where property_id = $1 order by sort_order`, [p.propertyId]);
  await h.sql(`update property_members set staff_id = $1 where id = $2`, [asha, p.members.worker.memberId]);

  await slip(1, '2026-09-10', day, [[asha, false]]);
  await slip(2, '2026-09-11', day, [[bharat, false]], true); // stitch-based: never counts
  await slip(1, '2026-09-12', day, [[asha, true]]);
  await slip(1, '2026-09-12', night, [[asha, true]]); // half on every slip: half day
  await slip(1, '2026-09-13', day, [[asha, true]]);
  await slip(1, '2026-09-13', night, [[asha, false]]); // one full slip: present
});
after(() => h.close());

describe('attendance', () => {
  it('lists every active person with their resolved day', async () => {
    const res = await as.supervisor.get('/v1/attendance/day', { date: '2026-09-10' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r: any) => r.staff.name), ['Asha', 'Bharat', 'Chetan']);
    assert.deepEqual(res.body[0].day, { date: '2026-09-10', status: 'present', fromProduction: true });
    assert.deepEqual(res.body[1].day, { date: '2026-09-10', status: null, fromProduction: false });
    assert.equal(res.body[0].staff.monthlySalary, undefined, 'a Person carries no pay');

    const others = await as.supervisor.get('/v1/attendance/day', { date: '2026-09-10', category: 'otherStaff' });
    assert.deepEqual(others.body.map((r: any) => r.staff.name), ['Chetan']);
  });

  it('shows a worker only their own row', async () => {
    const res = await as.worker.get('/v1/attendance/day', { date: '2026-09-10' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r: any) => r.staff.name), ['Asha']);
  });

  it('never counts a stitch-based slip; half only when every slip is half', async () => {
    assert.equal((await days(as.admin, bharat, '2026-09-11', '2026-09-11'))[0].status, null);
    const res = await days(as.admin, asha, '2026-09-10', '2026-09-13');
    assert.deepEqual(res.map((d: any) => [d.date, d.status, d.fromProduction]), [
      ['2026-09-10', 'present', true],
      ['2026-09-11', null, false],
      ['2026-09-12', 'halfDay', true],
      ['2026-09-13', 'present', true],
    ]);
  });

  it('refuses a backwards or overlong range', async () => {
    const back = await as.admin.get(`/v1/staff/${asha}/attendance`, { from: '2026-09-10', to: '2026-09-09' });
    assert.equal(back.status, 400);
    assert.equal(back.body.error.code, 'validation_failed');
    const long = await as.admin.get(`/v1/staff/${asha}/attendance`, { from: '2025-01-01', to: '2026-09-09' });
    assert.equal(long.status, 400);
  });

  it('lets a worker read only their own days', async () => {
    const own = await as.worker.get(`/v1/staff/${asha}/attendance`, { from: '2026-09-10', to: '2026-09-10' });
    assert.equal(own.status, 200);
    const other = await as.worker.get(`/v1/staff/${bharat}/attendance`, { from: '2026-09-10', to: '2026-09-10' });
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'forbidden');
    const mark = await as.worker.put('/v1/attendance/mark', { staffId: asha, date: '2026-09-01', status: 'present' });
    assert.equal(mark.status, 403);
    assert.equal(mark.body.error.details.action, 'attendance.mark');
  });

  it('a hand mark wins over production, and unmarking falls back to it', async () => {
    const res = await as.supervisor.put('/v1/attendance/mark', { staffId: asha, date: '2026-09-10', status: 'absent' });
    assert.equal(res.status, 204);
    assert.deepEqual((await days(as.admin, asha, '2026-09-10', '2026-09-10'))[0],
      { date: '2026-09-10', status: 'absent', fromProduction: false });

    const [{ id }] = await h.sql(`select id from attendance_marks where staff_id = $1`, [asha]);
    const del = await as.supervisor.del('/v1/attendance/mark', { staffId: String(asha), date: '2026-09-10' });
    assert.equal(del.status, 204);
    assert.equal((await days(as.admin, asha, '2026-09-10', '2026-09-10'))[0].status, 'present');
    const [cleared] = await h.sql(`select deleted_at, deleted_batch from attendance_marks where id = $1`, [id]);
    assert.ok(cleared.deleted_at);
    assert.equal(cleared.deleted_batch, null, 'a day tapped back has no batch');
    assert.equal((await binItems()).length, 0);

    // Marking it again revives the same row.
    await as.supervisor.put('/v1/attendance/mark', { staffId: asha, date: '2026-09-10', status: 'halfDay' });
    const rows = await h.sql(`select id, status, deleted_at from attendance_marks where staff_id = $1`, [asha]);
    assert.deepEqual(rows, [{ id, status: 'halfDay', deleted_at: null }]);
  });

  it('refuses a half day for someone not allowed half days', async () => {
    const res = await as.admin.put('/v1/attendance/mark', { staffId: bharat, date: '2026-09-01', status: 'halfDay' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.equal(res.body.error.details.fields.status, 'halfDayNotAllowed');
    const all = await as.admin.post('/v1/attendance/mark-all',
      { staffIds: [asha, bharat], date: '2026-09-01', status: 'halfDay' });
    assert.equal(all.status, 400);
    assert.equal((await h.sql(`select * from attendance_marks where work_date = '2026-09-01'`)).length, 0);
  });

  it('fills a month for one person and summarises each day', async () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-02', '2026-09-03'];
    const res = await as.admin.put('/v1/attendance/marks', { staffId: chetan, dates, status: 'present' });
    assert.equal(res.status, 204);
    await as.admin.put('/v1/attendance/mark', { staffId: bharat, date: '2026-09-02', status: 'absent' });

    const daily = (await as.viewAdmin.get('/v1/attendance/daily', { month: '2026-09' })).body;
    assert.equal(Object.keys(daily).length, 30);
    assert.deepEqual(daily['2026-09-02'], { present: 1, halfDay: 0, absent: 1, unmarked: 1 });
    assert.deepEqual(daily['2026-09-12'], { present: 0, halfDay: 1, absent: 0, unmarked: 2 });
    assert.deepEqual(daily['2026-09-30'], { present: 0, halfDay: 0, absent: 0, unmarked: 3 });
  });

  it('marks the rest present, and undoes it', async () => {
    const res = await as.supervisor.post('/v1/attendance/mark-all',
      { staffIds: [bharat, chetan], date: '2026-09-20', status: 'present' });
    assert.equal(res.status, 204);
    const d = (await as.admin.get('/v1/attendance/day', { date: '2026-09-20' })).body;
    assert.deepEqual(d.map((r: any) => r.day.status), [null, 'present', 'present']);

    const undo = await as.supervisor.post('/v1/attendance/undo-mark-all', { staffIds: [bharat, chetan], date: '2026-09-20' });
    assert.equal(undo.status, 204);
    const again = (await as.admin.get('/v1/attendance/day', { date: '2026-09-20' })).body;
    assert.deepEqual(again.map((r: any) => r.day.status), [null, null, null]);
    assert.equal((await binItems()).length, 0);
  });

  it('clears a month as one bin item, super admin only, audited', async () => {
    await as.admin.put('/v1/attendance/mark', { staffId: chetan, date: '2026-10-01', status: 'absent' });
    for (const who of ['admin', 'supervisor'] as const) {
      const refused = await as[who].post('/v1/attendance/clear-month', { staffId: chetan, month: '2026-09' });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, 'super_admin_only');
    }
    const res = await as.superAdmin.post('/v1/attendance/clear-month', { staffId: chetan, month: '2026-09' });
    assert.equal(res.status, 204);

    const bin = (await binItems()).map(({ kind, child_count, on_date }) => ({ kind, child_count, on_date }));
    assert.deepEqual(bin, [{ kind: 'attendance', child_count: 3, on_date: '2026-09-01' }]);
    const left = await days(as.admin, chetan, '2026-09-01', '2026-10-01');
    assert.deepEqual(left.filter((d: any) => d.status).map((d: any) => d.date), ['2026-10-01']);

    const [audit] = await h.sql(`select * from audit_log where action = 'attendance.clear_month'`);
    assert.equal(audit.destructive, true);
    assert.equal(audit.entity_id, String(chetan));
    assert.equal(audit.before.marks.length, 3);
  });

  it('cannot see or mark another property\'s people, or a deleted one', async () => {
    const other = await seedProperty(h);
    const [{ id }] = await h.sql(`insert into staff (property_id, name) values ($1, 'Elsewhere') returning id`,
      [other.propertyId]);
    for (const staffId of [id, gone]) {
      const mark = await as.admin.put('/v1/attendance/mark', { staffId, date: '2026-09-01', status: 'present' });
      assert.equal(mark.status, 404);
      const read = await as.admin.get(`/v1/staff/${staffId}/attendance`, { from: '2026-09-01', to: '2026-09-01' });
      assert.equal(read.status, 404);
    }
    assert.equal((await as.admin.post('/v1/attendance/clear-month', { staffId: id, month: '2026-09' })).status, 403);
    assert.equal((await as.superAdmin.post('/v1/attendance/clear-month', { staffId: id, month: '2026-09' })).status, 404);
  });

  it('summarises nothing for a unit with no one active', async () => {
    const empty = await seedProperty(h);
    const c = (await signInAll(h, empty)).admin;
    assert.deepEqual((await c.get('/v1/attendance/daily', { month: '2026-09' })).body, {});
  });
});
