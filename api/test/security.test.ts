// Holes found in review, pinned shut.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/auth/passwords.ts';
import {
  Client, PASSWORD, seedProperty, signInAll, startHarness, type Harness, type SeededProperty,
} from './helpers.ts';

let h: Harness;
let a: SeededProperty;
let b: SeededProperty;
let asA: Record<string, Client>;

before(async () => {
  h = await startHarness();
  a = await seedProperty(h);
  b = await seedProperty(h);
  asA = await signInAll(h, a);
});
after(() => h.close());

const login = (identifier: string, password: string) =>
  new Client(h.app).post('/v1/auth/login', { identifier, password, client: 'managerApp', keepSignedIn: false });

describe('a unit cannot take over a login it shares', () => {
  it('refuses to reset the password of another unit\'s owner added here', async () => {
    const victim = b.members.superAdmin.username;
    const add = await asA.supervisor.post('/v1/users', { displayName: 'x', username: victim, role: 'worker' });
    assert.equal(add.status, 200);
    assert.equal(add.body.temporaryPassword, '');
    const reset = await asA.supervisor.post(`/v1/users/${add.body.member.id}/reset-password`);
    assert.equal(reset.status, 403);
    assert.equal(reset.body.error.details.reason, 'sharedLogin');
    assert.equal((await login(victim, PASSWORD)).status, 200);
  });

  it('refuses to add StitchFlow staff as a member at all', async () => {
    const [{ id }] = await h.sql(
      `insert into users (display_name, email, password_hash, must_change_password)
       values ('Staff', 'staff@stitchflow.test', $1, false) returning id`, [await hashPassword(PASSWORD)]);
    await h.sql(`insert into platform_staff (user_id, role) values ($1, 'admin')`, [id]);
    const add = await asA.superAdmin.post('/v1/users', { displayName: 'x', email: 'staff@stitchflow.test', role: 'worker' });
    assert.equal(add.status, 403);
    assert.equal(add.body.error.details.reason, 'platformStaff');
  });

  it('still resets a login that is this unit\'s alone', async () => {
    const add = await asA.supervisor.post('/v1/users', { displayName: 'New', username: 'only-here', role: 'worker' });
    const reset = await asA.supervisor.post(`/v1/users/${add.body.member.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.equal((await login('only-here', reset.body.temporaryPassword)).status, 200);
  });
});

describe('only members who may see pay type a bonus by hand', () => {
  let slot: Record<string, unknown>;
  before(async () => {
    const [{ id: machineId }] = await h.sql(`insert into machines (property_id, number) values ($1, 1) returning id`, [a.propertyId]);
    const [{ id: shiftId }] = await h.sql(`select id from shifts where property_id = $1 order by sort_order limit 1`, [a.propertyId]);
    const [{ id: staffId }] = await h.sql(
      `insert into staff (property_id, name, category) values ($1, 'Ramu', 'karigar') returning id`, [a.propertyId]);
    slot = {
      machineId, workDate: '2026-09-10', shiftId, totalStitches: 0, embMinutes: 0, stopMinutes: 0,
      threadBreaks: 0, frames: 0, hasHeadLoss: false, isStitchBased: false,
      karigars: [{ staffId, isHalfDay: false }],
    };
  });

  it('ignores a worker\'s hand-typed bonus', async () => {
    const res = await asA.worker.put('/v1/production/entry', { ...slot, bonusAmount: 50000, bonusIsManual: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.entry.bonusAmount, 0);
    assert.equal(res.body.entry.bonusIsManual, false);
  });

  it('keeps an admin\'s hand-typed bonus when a supervisor saves the slip again', async () => {
    await asA.admin.put('/v1/production/entry', { ...slot, bonusAmount: 300, bonusIsManual: true });
    const res = await asA.supervisor.put('/v1/production/entry', { ...slot, totalStitches: 10, bonusAmount: 9999, bonusIsManual: true });
    assert.equal(res.body.entry.bonusAmount, 300);
    assert.equal(res.body.entry.bonusIsManual, true);
  });
});

describe('the recycle bin and pay', () => {
  it('hides advance and payslip amounts, and their restore, from a member without pay', async () => {
    const [{ id: staffId }] = await h.sql(
      `insert into staff (property_id, name, category) values ($1, 'Mohan', 'karigar') returning id`, [a.propertyId]);
    const [{ id: advanceId }] = await h.sql(
      `insert into advances (property_id, staff_id, given_on, amount, deleted_at) values ($1, $2, '2026-09-01', 777, now())
       returning id`, [a.propertyId, staffId]);
    // An admin narrowed to no pay.
    await h.sql(`insert into member_module_access (member_id, module, level) values ($1, 'advances', 'none'), ($1, 'payroll', 'none')`,
      [a.members.admin.memberId]);
    const narrowed = (await asA.admin.get('/v1/recycle-bin')).body.find((i: any) => i.kind === 'upad');
    assert.equal(narrowed.amount, null);
    const full = (await asA.superAdmin.get('/v1/recycle-bin')).body.find((i: any) => i.kind === 'upad');
    assert.equal(full.amount, 777);

    const refused = await asA.admin.post(`/v1/recycle-bin/upad/${advanceId}/restore`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.details.action, 'advances.record');
  });
});
