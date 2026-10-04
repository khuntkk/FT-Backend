import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { seedProperty, signInAll, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
});
after(() => h.close());

const add = (body: Record<string, unknown>) =>
  as.admin.post('/v1/staff', { category: 'karigar', monthlySalary: 15000, ...body });

describe('staff', () => {
  it('suggests 001 on an empty roster', async () => {
    const res = await as.admin.get('/v1/staff/next-code');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { code: '001' });
  });

  it('adds a person with the trade defaults, cleaned as the form cleans', async () => {
    const res = await add({ name: '  Ramesh ', code: ' 001 ', phone: '  ', monthlySalary: 15000.5 });
    assert.equal(res.status, 200);
    const s = res.body;
    assert.equal(typeof s.id, 'number');
    assert.equal(s.name, 'Ramesh');
    assert.equal(s.code, '001');
    assert.equal(s.phone, null);
    assert.equal(s.monthlySalary, 15000.5);
    assert.equal(s.payDaysPerMonth, 30);
    assert.equal(s.cutSalaryForAbsentDays, true);
    assert.equal(s.allowHalfDay, true);
    assert.equal(s.isActive, true);
    assert.match(s.createdAt, /Z$/);
  });

  it('suggests one past the highest numeric code among live people', async () => {
    await add({ name: 'Suresh', code: '005' });
    await add({ name: 'Mahesh', code: 'A12' });
    await add({ name: 'Dinesh', code: null, category: 'designer', joinedOn: '2026-03-01' });
    const gone = await add({ name: 'Gone', code: '009' });
    await as.superAdmin.del(`/v1/staff/${gone.body.id}`);
    assert.deepEqual((await as.admin.get('/v1/staff/next-code')).body, { code: '006' });
  });

  it('lists live people by name, filtered by active and category', async () => {
    const all = await as.viewAdmin.get('/v1/staff');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map((s: any) => s.name), ['Dinesh', 'Mahesh', 'Ramesh', 'Suresh']);
    assert.equal(all.body[0].joinedOn, '2026-03-01');

    const mahesh = all.body.find((s: any) => s.name === 'Mahesh');
    await as.admin.patch(`/v1/staff/${mahesh.id}`, { isActive: false });
    const active = await as.admin.get('/v1/staff', { activeOnly: 'true' });
    assert.deepEqual(active.body.map((s: any) => s.name), ['Dinesh', 'Ramesh', 'Suresh']);
    const designers = await as.admin.get('/v1/staff', { category: 'designer' });
    assert.deepEqual(designers.body.map((s: any) => s.name), ['Dinesh']);
  });

  it('refuses a code a live person has, on add and on change', async () => {
    const taken = await add({ name: 'Copy', code: '005' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'staff_code_taken');
    assert.deepEqual(taken.body.error.details, { code: '005' });

    const ramesh = (await as.admin.get('/v1/staff')).body.find((s: any) => s.name === 'Ramesh');
    const clash = await as.admin.patch(`/v1/staff/${ramesh.id}`, { code: '005' });
    assert.equal(clash.status, 409);
    assert.deepEqual(clash.body.error.details, { code: '005' });
  });

  it('lets a deleted person\'s code be used again', async () => {
    const res = await add({ name: 'Again', code: '009' });
    assert.equal(res.status, 200);
    await as.superAdmin.del(`/v1/staff/${res.body.id}`);
  });

  it('changes a person; null clears; one person reads back', async () => {
    const ramesh = (await as.admin.get('/v1/staff')).body.find((s: any) => s.name === 'Ramesh');
    const res = await as.admin.patch(`/v1/staff/${ramesh.id}`, {
      code: null, monthlySalary: 18000, payDaysPerMonth: 26, cutSalaryForAbsentDays: false, notes: 'night',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, null);
    assert.equal(res.body.monthlySalary, 18000);
    assert.equal(res.body.payDaysPerMonth, 26);
    assert.equal(res.body.cutSalaryForAbsentDays, false);
    const one = await as.viewAdmin.get(`/v1/staff/${ramesh.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.notes, 'night');
    assert.equal((await as.admin.patch('/v1/staff/999999', { name: 'x' })).status, 404);
    assert.equal((await as.admin.get('/v1/staff/999999')).status, 404);
  });

  it('never shows the roster to a supervisor or an operator, but gives them operators without pay', async () => {
    for (const who of ['supervisor', 'worker']) {
      const res = await as[who].get('/v1/staff');
      assert.equal(res.status, 403, who);
      assert.equal(res.body.error.code, 'forbidden');
      assert.equal(res.body.error.details.action, 'staff.view');

      const ops = await as[who].get('/v1/operators');
      assert.equal(ops.status, 200, who);
      assert.deepEqual(Object.keys(ops.body[0]).sort(),
        ['category', 'code', 'id', 'isActive', 'name', 'photoFileId']);
    }
    const ops = await as.supervisor.get('/v1/operators', { activeOnly: 'true' });
    assert.deepEqual(ops.body.map((s: any) => s.name), ['Dinesh', 'Ramesh', 'Suresh']);
  });

  it('lets a view admin read the roster but not add, change or take a code', async () => {
    const id = (await as.admin.get('/v1/staff')).body[0].id;
    const cases: [string, Promise<any>][] = [
      ['staff.create', as.viewAdmin.post('/v1/staff', { name: 'x', category: 'karigar', monthlySalary: 1 })],
      ['staff.update', as.viewAdmin.patch(`/v1/staff/${id}`, { name: 'x' })],
      ['staff.create', as.viewAdmin.get('/v1/staff/next-code')],
    ];
    for (const [action, call] of cases) {
      const res = await call;
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
      assert.equal(res.body.error.details.action, action);
    }
  });

  it('deletes only for a super admin: advances and payslips go in the same batch, slips stay', async () => {
    const s = (await add({ name: 'Leaver', code: '050' })).body;
    const [{ id: machineId }] = await h.sql(
      `insert into machines (property_id, number) values ($1, 1) returning id`, [p.propertyId]);
    const [{ id: shiftId }] = await h.sql(`select id from shifts where property_id = $1 limit 1`, [p.propertyId]);
    const [{ id: entryId }] = await h.sql(
      `insert into production_entries (property_id, machine_id, work_date, shift_id, total_stitches)
       values ($1, $2, '2026-08-10', $3, 100000) returning id`, [p.propertyId, machineId, shiftId]);
    await h.sql(`insert into entry_karigars (property_id, entry_id, staff_id) values ($1, $2, $3)`,
      [p.propertyId, entryId, s.id]);
    await h.sql(
      `insert into advances (property_id, staff_id, given_on, amount) values ($1, $2, '2026-08-01', 500), ($1, $2, '2026-08-02', 300)`,
      [p.propertyId, s.id]);
    // One advance was already in the bin on its own; it keeps its own batch.
    await h.sql(
      `update advances set deleted_at = now(), deleted_batch = gen_random_uuid()
       where staff_id = $1 and amount = 300`, [s.id]);
    await h.sql(
      `insert into salary_payments (property_id, staff_id, period_start, period_end)
       values ($1, $2, '2026-07-01', '2026-07-31')`, [p.propertyId, s.id]);

    const refused = await as.admin.del(`/v1/staff/${s.id}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'super_admin_only');

    const res = await as.superAdmin2.del(`/v1/staff/${s.id}`);
    assert.equal(res.status, 204);
    assert.equal((await as.admin.get(`/v1/staff/${s.id}`)).status, 404);
    assert.ok(!(await as.admin.get('/v1/staff')).body.some((x: any) => x.id === s.id));

    const [person] = await h.sql(`select deleted_batch from staff where id = $1`, [s.id]);
    const adv = await h.sql(`select amount, deleted_batch from advances where staff_id = $1 order by amount`, [s.id]);
    const [slip] = await h.sql(`select deleted_batch from salary_payments where staff_id = $1`, [s.id]);
    assert.ok(person.deleted_batch);
    assert.equal(adv[1].deleted_batch, person.deleted_batch);
    assert.notEqual(adv[0].deleted_batch, person.deleted_batch);
    assert.equal(slip.deleted_batch, person.deleted_batch);
    const [entry] = await h.sql(`select deleted_at from production_entries where id = $1`, [entryId]);
    assert.equal(entry.deleted_at, null);
    assert.equal((await h.sql(`select 1 from entry_karigars where staff_id = $1`, [s.id])).length, 1);

    const [audit] = await h.sql(`select * from audit_log where action = 'staff.delete' and entity_id = $1`, [String(s.id)]);
    assert.equal(audit.destructive, true);
    assert.equal(audit.entity_type, 'staff');
    assert.equal(audit.before.code, '050');
    assert.equal(audit.before.monthlySalary, 15000);
  });

  it('cannot see or touch another property\'s people', async () => {
    const other = await seedProperty(h);
    const [{ id }] = await h.sql(
      `insert into staff (property_id, name, code) values ($1, 'Stranger', '777') returning id`, [other.propertyId]);
    assert.equal((await as.admin.get(`/v1/staff/${id}`)).status, 404);
    assert.equal((await as.admin.patch(`/v1/staff/${id}`, { name: 'x' })).status, 404);
    assert.equal((await as.superAdmin.del(`/v1/staff/${id}`)).status, 404);
    assert.ok(!(await as.admin.get('/v1/staff')).body.some((s: any) => s.id === id));
    assert.ok(!(await as.supervisor.get('/v1/operators')).body.some((s: any) => s.id === id));
    // Another unit's codes neither clash nor count.
    assert.equal((await add({ name: 'Local 777', code: '777' })).status, 200);
    assert.deepEqual((await as.admin.get('/v1/staff/next-code')).body, { code: '778' });
  });
});
