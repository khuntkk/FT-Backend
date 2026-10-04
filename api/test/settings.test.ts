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

describe('settings', () => {
  it('reads the unit\'s settings', async () => {
    const res = await as.viewAdmin.get('/v1/settings');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      businessName: `Unit ${p.code.split('-')[1]}`, currencySymbol: '₹', shiftScheme: 'dayNight',
      dayStartMinute: 480, noLeaveBonusAmount: 0, stitchBasedEnabled: false, stitchBasedRatePerThousand: 0,
      timezone: 'Asia/Kolkata',
    });
    const refused = await as.supervisor.get('/v1/settings');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.details.action, 'settings.view');
  });

  it('lets a super admin change any subset', async () => {
    const res = await as.superAdmin2.patch('/v1/settings', { noLeaveBonusAmount: 500, stitchBasedEnabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.noLeaveBonusAmount, 500);
    assert.equal(res.body.stitchBasedEnabled, true);
    assert.equal(res.body.businessName, `Unit ${p.code.split('-')[1]}`);
    const again = await as.superAdmin.patch('/v1/settings', { stitchBasedRatePerThousand: 1.2345, businessName: 'Janki' });
    assert.equal(again.body.stitchBasedRatePerThousand, 1.2345);
    assert.equal(again.body.noLeaveBonusAmount, 500);
  });

  it('lets an admin change settings only once raised to edit; a view admin never', async () => {
    const before = await as.admin.patch('/v1/settings', { currencySymbol: 'Rs' });
    assert.equal(before.status, 403);
    assert.equal(before.body.error.code, 'forbidden');
    assert.equal(before.body.error.details.action, 'settings.update');

    await h.sql(
      `insert into member_module_access (member_id, module, level, granted_by_member_id) values ($1, 'settings', 'edit', $2)`,
      [p.members.admin.memberId, p.members.superAdmin.memberId]);
    const res = await as.admin.patch('/v1/settings', { currencySymbol: 'Rs' });
    assert.equal(res.status, 200);
    assert.equal(res.body.currencySymbol, 'Rs');

    const view = await as.viewAdmin.patch('/v1/settings', { currencySymbol: '$' });
    assert.equal(view.status, 403);
    assert.equal(view.body.error.code, 'forbidden');
  });

  it('sends the shift arrangement and day start to /shifts/scheme', async () => {
    const res = await as.superAdmin.patch('/v1/settings', { shiftScheme: 'threeShift', dayStartMinute: 360 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.deepEqual(Object.keys(res.body.error.details.fields).sort(), ['dayStartMinute', 'shiftScheme']);
    assert.equal((await as.superAdmin.get('/v1/settings')).body.shiftScheme, 'dayNight');
  });
});

describe('reset data', () => {
  /** One of every record Reset removes, some in the bin; returns the person's id. */
  async function arrange(propertyId: number): Promise<number> {
    const [{ id: staffId }] = await h.sql(
      `insert into staff (property_id, name, code) values ($1, 'Ramesh', '001') returning id`, [propertyId]);
    await h.sql(`insert into staff (property_id, name, deleted_at) values ($1, 'Binned', now())`, [propertyId]);
    const [{ id: machineId }] = await h.sql(
      `insert into machines (property_id, number) values ($1, 1) returning id`, [propertyId]);
    const [{ id: shiftId }] = await h.sql(`select id from shifts where property_id = $1 limit 1`, [propertyId]);
    const [{ id: entryId }] = await h.sql(
      `insert into production_entries (property_id, machine_id, work_date, shift_id) values ($1, $2, '2026-08-10', $3)
       returning id`, [propertyId, machineId, shiftId]);
    await h.sql(`insert into entry_karigars (property_id, entry_id, staff_id) values ($1, $2, $3)`,
      [propertyId, entryId, staffId]);
    const [{ id: fileId }] = await h.sql(
      `insert into files (property_id, purpose, storage_key, content_type, byte_size, sha256)
       values ($1, 'slipPhoto', gen_random_uuid()::text, 'image/jpeg', 10, repeat('a', 64)) returning id`,
      [propertyId]);
    await h.sql(
      `insert into slip_scans (property_id, machine_id, entry_id, photo_file_id, engine) values ($1, $2, $3, $4, 'mlkitLatin')`,
      [propertyId, machineId, entryId, fileId]);
    await h.sql(`insert into attendance_marks (property_id, staff_id, work_date) values ($1, $2, '2026-08-10')`,
      [propertyId, staffId]);
    await h.sql(`insert into advances (property_id, staff_id, given_on, amount) values ($1, $2, '2026-08-01', 500)`,
      [propertyId, staffId]);
    await h.sql(
      `insert into salary_payments (property_id, staff_id, period_start, period_end) values ($1, $2, '2026-07-01', '2026-07-31')`,
      [propertyId, staffId]);
    await h.sql(`insert into bonus_rules (property_id, name) values ($1, 'Day bonus')`, [propertyId]);
    return staffId;
  }

  const count = async (table: string, propertyId: number) =>
    Number((await h.sql(`select count(*) as n from ${table} where property_id = $1`, [propertyId]))[0].n);

  it('is the owner\'s alone', async () => {
    for (const who of ['superAdmin2', 'admin']) {
      const res = await as[who].post('/v1/settings/reset-data', { confirmPropertyCode: p.code });
      assert.equal(res.status, 403, who);
      assert.equal(res.body.error.code, 'owner_only', who);
      assert.equal(res.body.error.details.action, 'settings.reset_data');
    }
  });

  it('wants the unit\'s code typed', async () => {
    const res = await as.superAdmin.post('/v1/settings/reset-data', { confirmPropertyCode: 'unit-x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(res.body.error.details.fields.confirmPropertyCode);
  });

  it('wipes the records, keeps members, shifts, rules and settings, and leaves other units alone', async () => {
    const staffId = await arrange(p.propertyId);
    const other = await seedProperty(h);
    await arrange(other.propertyId);
    await h.sql(`update property_members set staff_id = $1 where id = $2`, [staffId, p.members.worker.memberId]);

    const res = await as.superAdmin.post('/v1/settings/reset-data', { confirmPropertyCode: p.code.toUpperCase() });
    assert.equal(res.status, 204);

    for (const table of ['staff', 'machines', 'production_entries', 'entry_karigars', 'slip_scans',
      'attendance_marks', 'advances', 'salary_payments']) {
      assert.equal(await count(table, p.propertyId), 0, table);
      assert.ok(await count(table, other.propertyId) > 0, `other unit's ${table}`);
    }
    assert.equal(await count('property_members', p.propertyId), 6);
    assert.equal(await count('shifts', p.propertyId), 2);
    assert.equal(await count('bonus_rules', p.propertyId), 1);
    assert.equal(await count('property_settings', p.propertyId), 1);
    const [worker] = await h.sql(`select staff_id from property_members where id = $1`, [p.members.worker.memberId]);
    assert.equal(worker.staff_id, null);
    // The worker can still sign in and work.
    assert.equal((await as.worker.get('/v1/operators')).status, 200);

    const [audit] = await h.sql(`select * from audit_log where action = 'settings.reset_data'`);
    assert.equal(audit.destructive, true);
    assert.equal(audit.entity_type, 'property');
    assert.equal(audit.entity_id, String(p.propertyId));
    assert.deepEqual(audit.after.removed, {
      entryKarigars: 1, slipScans: 1, productionEntries: 1, attendanceMarks: 1,
      advances: 1, salaryPayments: 1, machines: 1, staff: 2,
    });
  });
});
