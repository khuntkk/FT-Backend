import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Tx } from '../src/db/db.ts';
import { purgeExpired } from '../src/services/recycleBin.ts';
import { seedProperty, signInAll, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;
let dayShift: number;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h, { machineLimit: 4 });
  as = await signInAll(h, p);
  [{ id: dayShift }] = await h.sql(`select id from shifts where property_id = $1 and name = 'Day'`, [p.propertyId]);
});
after(() => h.close());

// Arranging data with superuser SQL keeps these tests about the bin, not
// about the modules that put things in it.
async function machine(number: number, name: string | null = null, propertyId = p.propertyId): Promise<number> {
  const [{ id }] = await h.sql(`insert into machines (property_id, number, name) values ($1, $2, $3) returning id`,
    [propertyId, number, name]);
  return id;
}
async function person(name: string, code: string | null = null): Promise<number> {
  const [{ id }] = await h.sql(`insert into staff (property_id, name, code) values ($1, $2, $3) returning id`,
    [p.propertyId, name, code]);
  return id;
}
async function slip(machineId: number, date: string, operators: number[] = []): Promise<number> {
  const [{ id }] = await h.sql(
    `insert into production_entries (property_id, machine_id, work_date, shift_id, total_stitches)
     values ($1, $2, $3, $4, 100000) returning id`, [p.propertyId, machineId, date, dayShift]);
  for (const s of operators) {
    await h.sql(`insert into entry_karigars (property_id, entry_id, staff_id) values ($1, $2, $3)`, [p.propertyId, id, s]);
  }
  return id;
}
async function advance(staffId: number, amount = 500): Promise<number> {
  const [{ id }] = await h.sql(
    `insert into advances (property_id, staff_id, given_on, amount) values ($1, $2, '2026-09-05', $3) returning id`,
    [p.propertyId, staffId, amount]);
  return id;
}
async function payslip(staffId: number, month = '2026-08-01'): Promise<number> {
  const [{ id }] = await h.sql(
    `insert into salary_payments (property_id, staff_id, period_start, period_end, net_payable)
     values ($1, $2, $3::date, ($3::date + interval '1 month')::date, 9000) returning id`,
    [p.propertyId, staffId, month]);
  return id;
}
/** Soft-deletes a row in a new batch, or in the given one. Returns the batch. */
async function softDelete(table: string, id: number, batch: string | null = null, ago = '0 seconds'): Promise<string> {
  const [row] = await h.sql(
    `update ${table} set deleted_at = now() - $3::interval, deleted_batch = coalesce($2::uuid, gen_random_uuid())
     where id = $1 returning deleted_batch`, [id, batch, ago]);
  return row.deleted_batch;
}
const exists = async (table: string, id: number) =>
  (await h.sql(`select deleted_at from ${table} where id = $1`, [id]))[0] ?? null;
const bin = async () => (await as.admin.get('/v1/recycle-bin')).body as any[];
const inBin = async (kind: string, id: number) => (await bin()).find((i) => i.kind === kind && i.id === id);
const binIds = async () => (await bin()).map((i) => `${i.kind}:${i.id}`);

describe('recycle bin', () => {
  it('lists a deleted machine with its slips folded in, newest first, with seven days to go', async () => {
    const m = await machine(1, 'Tajima');
    await slip(m, '2026-09-01');
    await slip(m, '2026-09-02');
    const rule = await h.sql(`insert into bonus_rules (property_id, name) values ($1, 'Old rule') returning id`, [p.propertyId]);
    await softDelete('bonus_rules', rule[0].id, null, '1 hour');
    assert.equal((await as.superAdmin.del(`/v1/machines/${m}`)).status, 204);

    const items = await bin();
    assert.deepEqual(items.map((i) => i.kind), ['machine', 'bonusRule']);
    const [item] = items;
    assert.equal(item.id, m);
    assert.equal(item.name, 'Tajima');
    assert.equal(item.machineNumber, 1);
    assert.equal(item.childCount, 2);
    assert.match(item.deletedAt, /Z$/);
    assert.equal(Date.parse(item.expiresAt) - Date.parse(item.deletedAt), 7 * 24 * 3600 * 1000);
    assert.equal(item.category, null);
    assert.equal(items[1].name, 'Old rule');
    assert.equal(items[1].condition, 'fullHead');
    assert.equal(items[1].bonusKind, 'perThousandSlab');
  });

  it('is read by a view admin, hidden from a supervisor; restore needs edit, deleting needs a super admin', async () => {
    assert.equal((await as.viewAdmin.get('/v1/recycle-bin')).status, 200);
    const sup = await as.supervisor.get('/v1/recycle-bin');
    assert.equal(sup.status, 403);
    assert.equal(sup.body.error.code, 'forbidden');
    const [item] = await bin();
    const view = await as.viewAdmin.post(`/v1/recycle-bin/${item.kind}/${item.id}/restore`);
    assert.equal(view.status, 403);
    assert.equal(view.body.error.details.action, 'recycle_bin.restore');
    const forever = await as.admin.del(`/v1/recycle-bin/${item.kind}/${item.id}`);
    assert.equal(forever.status, 403);
    assert.equal(forever.body.error.code, 'super_admin_only');
    const emptied = await as.admin.del('/v1/recycle-bin');
    assert.equal(emptied.body.error.code, 'super_admin_only');
  });

  it('restores a machine with exactly the slips deleted with it', async () => {
    const m = await machine(2);
    const alone = await slip(m, '2026-09-01');
    await softDelete('production_entries', alone, null, '1 hour');
    const withIt = await slip(m, '2026-09-02');
    await as.superAdmin.del(`/v1/machines/${m}`);
    assert.equal((await inBin('machine', m)).childCount, 1);

    // The slip deleted on its own waits for its machine.
    const early = await as.admin.post(`/v1/recycle-bin/productionEntry/${alone}/restore`);
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'restore_blocked');
    assert.deepEqual(early.body.error.details, { problem: 'parentDeleted', name: null, number: 2 });

    assert.equal((await as.admin.post(`/v1/recycle-bin/machine/${m}/restore`)).status, 204);
    assert.equal((await exists('machines', m)).deleted_at, null);
    assert.equal((await exists('production_entries', withIt)).deleted_at, null);
    assert.notEqual((await exists('production_entries', alone)).deleted_at, null);
    const [batch] = await h.sql(`select deleted_batch, deleted_by_member_id from machines where id = $1`, [m]);
    assert.deepEqual(batch, { deleted_batch: null, deleted_by_member_id: null });

    // Now its machine is back, so may it be.
    assert.equal((await as.admin.post(`/v1/recycle-bin/productionEntry/${alone}/restore`)).status, 204);
    assert.equal(await inBin('productionEntry', alone), undefined);
  });

  it('refuses a machine whose number was taken since', async () => {
    const m = await machine(3, 'Old three');
    await as.superAdmin.del(`/v1/machines/${m}`);
    await machine(3, 'New three');
    const res = await as.admin.post(`/v1/recycle-bin/machine/${m}/restore`);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details, { problem: 'machineNumberTaken', name: 'Old three', number: 3 });
  });

  it('refuses a machine with no place left, as the database raises it', async () => {
    // Live now: 2, 3 (new). Limit 4.
    const m = await machine(9);
    await as.superAdmin.del(`/v1/machines/${m}`);
    await machine(10);
    await machine(11);
    const res = await as.admin.post(`/v1/recycle-bin/machine/${m}/restore`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'machine_limit_reached');
    assert.deepEqual(res.body.error.details, { limit: 4, used: 4 });
    assert.notEqual((await exists('machines', m)).deleted_at, null);
  });

  it('restores a person with their advances and payslips, and nothing deleted apart', async () => {
    const s = await person('Ramesh', 'R1');
    const earlier = await advance(s, 100);
    await softDelete('advances', earlier, null, '1 hour');
    const a = await advance(s);
    const pay = await payslip(s);
    const batch = await softDelete('staff', s);
    await softDelete('advances', a, batch);
    await softDelete('salary_payments', pay, batch);
    assert.equal((await inBin('staff', s)).childCount, 2);
    assert.equal((await inBin('staff', s)).code, 'R1');

    const blocked = await as.admin.post(`/v1/recycle-bin/upad/${earlier}/restore`);
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body.error.details, { problem: 'parentDeleted', name: 'Ramesh' });

    assert.equal((await as.admin.post(`/v1/recycle-bin/staff/${s}/restore`)).status, 204);
    assert.equal((await exists('advances', a)).deleted_at, null);
    assert.equal((await exists('salary_payments', pay)).deleted_at, null);
    assert.notEqual((await exists('advances', earlier)).deleted_at, null);
    assert.equal((await as.admin.post(`/v1/recycle-bin/upad/${earlier}/restore`)).status, 204);
  });

  it('refuses a payslip for a month paid again since', async () => {
    const s = await person('Suresh');
    const old = await payslip(s, '2026-07-01');
    await softDelete('salary_payments', old);
    const item = await inBin('salaryPayment', old);
    assert.equal(item.date, '2026-07-01');
    assert.equal(item.amount, 9000);
    await payslip(s, '2026-07-01');
    const res = await as.admin.post(`/v1/recycle-bin/salaryPayment/${old}/restore`);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details, { problem: 'periodAlreadyPaid' });
  });

  it('handles an advance or payslip deleted on its own with no batch', async () => {
    const s = await person('Dinesh');
    const a = await advance(s);
    const pay = await payslip(s, '2026-06-01');
    await h.sql(`update advances set deleted_at = now() where id = $1`, [a]);
    await h.sql(`update salary_payments set deleted_at = now() where id = $1`, [pay]);
    assert.equal((await inBin('upad', a)).name, 'Dinesh');
    assert.ok(await inBin('salaryPayment', pay));
    assert.equal((await as.admin.post(`/v1/recycle-bin/upad/${a}/restore`)).status, 204);
    assert.equal((await exists('advances', a)).deleted_at, null);
    assert.equal((await as.superAdmin.del(`/v1/recycle-bin/salaryPayment/${pay}`)).status, 204);
    assert.equal(await exists('salary_payments', pay), null);
  });

  it('restores a cleared month as one item, named by its lowest id', async () => {
    const s = await person('Mahesh');
    const ids: number[] = [];
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      const [{ id }] = await h.sql(
        `insert into attendance_marks (property_id, staff_id, work_date) values ($1, $2, $3) returning id`,
        [p.propertyId, s, d]);
      ids.push(id);
    }
    const [{ batch }] = await h.sql(`select gen_random_uuid() as batch`);
    for (const id of ids) await softDelete('attendance_marks', id, batch);
    const item = await inBin('attendance', ids[0]);
    assert.equal(item.childCount, 3);
    assert.equal(item.date, '2026-09-01');
    assert.equal(item.name, 'Mahesh');
    assert.equal((await as.admin.post(`/v1/recycle-bin/attendance/${ids[1]}/restore`)).status, 404);
    assert.equal((await as.admin.post(`/v1/recycle-bin/attendance/${ids[0]}/restore`)).status, 204);
    const marks = await h.sql(`select count(*)::int as n from attendance_marks where staff_id = $1 and deleted_at is null`, [s]);
    assert.equal(marks[0].n, 3);
  });

  it('answers 404 for what is not in the bin, or another property\'s', async () => {
    const other = await seedProperty(h);
    const theirs = await machine(1, null, other.propertyId);
    await h.sql(`update machines set deleted_at = now(), deleted_batch = gen_random_uuid() where id = $1`, [theirs]);
    assert.equal((await as.admin.post(`/v1/recycle-bin/machine/${theirs}/restore`)).status, 404);
    assert.equal((await as.superAdmin.del(`/v1/recycle-bin/machine/${theirs}`)).status, 404);
    assert.ok(!(await binIds()).includes(`machine:${theirs}`));
    await h.sql(`update properties set machine_limit = 50 where id = $1`, [p.propertyId]);
    const live = await machine(20);
    assert.equal((await as.admin.post(`/v1/recycle-bin/machine/${live}/restore`)).status, 404);
    assert.equal((await as.admin.post(`/v1/recycle-bin/teapot/${live}/restore`)).status, 400);
  });
});

describe('delete forever and empty', () => {
  it('deletes a machine and its slips for good, audited with what it was', async () => {
    const m = await machine(30, 'Gone');
    const s1 = await slip(m, '2026-09-01');
    const alone = await slip(m, '2026-09-02');
    await softDelete('production_entries', alone, null, '1 hour');
    await as.superAdmin.del(`/v1/machines/${m}`);
    const res = await as.superAdmin2.del(`/v1/recycle-bin/machine/${m}`);
    assert.equal(res.status, 204);
    assert.equal(await exists('machines', m), null);
    assert.equal(await exists('production_entries', s1), null);
    assert.equal(await exists('production_entries', alone), null);
    const [audit] = await h.sql(
      `select * from audit_log where action = 'recycle_bin.delete_forever' and entity_type = 'machine'`);
    assert.equal(audit.destructive, true);
    assert.equal(audit.entity_type, 'machine');
    assert.equal(audit.entity_id, String(m));
    assert.equal(audit.before.name, 'Gone');
    assert.equal(audit.before.childCount, 1);
  });

  it('keeps a person who ran machines out of sight, not removed; removes one who did not', async () => {
    const m = await machine(31);
    const ran = await person('Ran machines');
    const never = await person('Never ran');
    const entry = await slip(m, '2026-09-03', [ran]);
    const a = await advance(ran);
    const batch = await softDelete('staff', ran);
    await softDelete('advances', a, batch);
    await softDelete('staff', never);
    await advance(never);

    assert.equal((await as.superAdmin.del(`/v1/recycle-bin/staff/${ran}`)).status, 204);
    assert.equal((await as.superAdmin.del(`/v1/recycle-bin/staff/${never}`)).status, 204);

    const kept = await h.sql(`select deleted_at < now() - interval '7 days' as past from staff where id = $1`, [ran]);
    assert.deepEqual(kept, [{ past: true }]);
    assert.equal(await inBin('staff', ran), undefined);
    assert.equal(await exists('advances', a), null);
    assert.equal((await h.sql(`select 1 from entry_karigars where entry_id = $1`, [entry])).length, 1);
    assert.equal(await exists('staff', never), null);
    assert.equal((await h.sql(`select 1 from advances where staff_id = $1`, [never])).length, 0);
  });

  it('empties the bin, each item as delete-forever would take it', async () => {
    const m = await machine(32);
    const ran = await person('Ran too');
    await slip(m, '2026-09-04', [ran]);
    await softDelete('staff', ran);
    const rule = (await h.sql(`insert into bonus_rules (property_id, name) values ($1, 'R') returning id`, [p.propertyId]))[0].id;
    await softDelete('bonus_rules', rule);
    const m2 = await machine(33);
    await slip(m2, '2026-09-04');
    await as.superAdmin.del(`/v1/machines/${m2}`);
    const before = await bin();
    assert.ok(before.length >= 4);

    assert.equal((await as.superAdmin.del('/v1/recycle-bin')).status, 204);
    assert.deepEqual(await bin(), []);
    assert.equal(await exists('bonus_rules', rule), null);
    assert.equal(await exists('machines', m2), null);
    assert.notEqual(await exists('staff', ran), null);
    const [audit] = await h.sql(`select * from audit_log where action = 'recycle_bin.empty'`);
    assert.equal(audit.before.length, before.length);
    assert.equal(audit.entity_type, 'recycle_bin');
  });
});

describe('the daily purge', () => {
  it('drops what is past seven days in every property, children first, keeping people who ran machines', async () => {
    // As superuser, which sees every property — as the platform role does.
    const tx: Tx = {
      rows: (sql, params) => h.sql(sql, params),
      one: async (sql, params) => (await h.sql(sql, params))[0],
      exec: () => { throw new Error('purgeExpired should use rows/one'); },
      afterCommit: () => {},
    };
    const other = await seedProperty(h);
    const old = '8 days';

    const m = await machine(40);
    const slipOnIt = await slip(m, '2026-09-05');
    const mBatch = await softDelete('machines', m, null, old);
    await softDelete('production_entries', slipOnIt, mBatch, old);

    const liveMachine = await machine(41);
    const ran = await person('Old operator');
    const liveSlip = await slip(liveMachine, '2026-09-05', [ran]);
    await softDelete('staff', ran, null, old);

    const never = await person('Old helper');
    const adv = await advance(never);
    const sBatch = await softDelete('staff', never, null, old);
    await softDelete('advances', adv, sBatch, old);

    const recent = await machine(42);
    await softDelete('machines', recent, null, '6 days');

    const theirs = await machine(1, null, other.propertyId);
    await h.sql(`update machines set deleted_at = now() - interval '8 days', deleted_batch = gen_random_uuid() where id = $1`, [theirs]);

    const counts = await purgeExpired(tx);
    assert.ok(counts.machines >= 2);
    assert.ok(counts.production_entries >= 1);
    assert.ok(counts.advances >= 1);
    assert.ok(counts.staff >= 1);

    assert.equal(await exists('machines', m), null);
    assert.equal(await exists('production_entries', slipOnIt), null);
    assert.equal(await exists('machines', theirs), null);
    assert.equal(await exists('staff', never), null);
    assert.equal(await exists('advances', adv), null);
    assert.notEqual(await exists('staff', ran), null);
    assert.notEqual(await exists('production_entries', liveSlip), null);
    assert.notEqual(await exists('machines', recent), null);
    assert.ok(await inBin('machine', recent));

    // Nothing left to purge: a second run is a no-op.
    const again = await purgeExpired(tx);
    assert.ok(Object.values(again).every((n) => n === 0));
  });
});
