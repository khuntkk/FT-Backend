import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { todayIn } from '@stitchflow/contract';
import { seedProperty, signInAll, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;
let ravi: number;
let sita: number;

const person = async (name: string, propertyId = p.propertyId) =>
  (await h.sql(`insert into staff (property_id, name) values ($1, $2) returning id`, [propertyId, name]))[0].id as number;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
  ravi = await person('Ravi');
  sita = await person('Sita');
});
after(() => h.close());

describe('advances', () => {
  it('records an advance, rounded to the paisa', async () => {
    const res = await as.admin.post('/v1/advances', { staffId: ravi, givenOn: '2026-08-05', amount: 2000, mode: 'cash' });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.id, 'number');
    assert.deepEqual({ ...res.body, id: 0, createdAt: '' }, {
      id: 0, staffId: ravi, givenOn: '2026-08-05', amount: 2000, mode: 'cash', note: null, createdAt: '',
    });
    assert.match(res.body.createdAt, /Z$/);
    await as.admin.post('/v1/advances', { staffId: ravi, givenOn: '2026-09-02', amount: 500.5, mode: 'bank', note: 'Rent' });
    await as.admin.post('/v1/advances', { staffId: sita, givenOn: '2026-09-03', amount: 700, mode: 'cash' });
  });

  it('refuses nothing or less, and people not here', async () => {
    for (const amount of [0, -100]) {
      const res = await as.admin.post('/v1/advances', { staffId: ravi, givenOn: '2026-09-01', amount, mode: 'cash' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'validation_failed');
    }
    const other = await seedProperty(h);
    const elsewhere = await person('Elsewhere', other.propertyId);
    const gone = await person('Gone');
    await h.sql(`update staff set deleted_at = now() where id = $1`, [gone]);
    for (const staffId of [elsewhere, gone]) {
      const res = await as.admin.post('/v1/advances', { staffId, givenOn: '2026-09-01', amount: 10, mode: 'cash' });
      assert.equal(res.status, 404);
      assert.equal((await as.admin.get(`/v1/staff/${staffId}/advance-balance`)).status, 404);
    }
  });

  it('lists by month and person, newest first', async () => {
    const sept = (await as.viewAdmin.get('/v1/advances', { month: '2026-09' })).body;
    assert.deepEqual(sept.map((a: any) => [a.givenOn, a.amount]), [['2026-09-03', 700], ['2026-09-02', 500.5]]);
    const raviAll = (await as.viewAdmin.get('/v1/advances', { staffId: String(ravi) })).body;
    assert.deepEqual(raviAll.map((a: any) => a.givenOn), ['2026-09-02', '2026-08-05']);
  });

  it('works out the balance going into a month, and now', async () => {
    const aug = await as.admin.get(`/v1/staff/${ravi}/advance-balance`, { month: '2026-08' });
    assert.deepEqual(aug.body, { owedGoingIn: 2000, givenInMonth: 2000 });
    const sept = await as.admin.get(`/v1/staff/${ravi}/advance-balance`, { month: '2026-09' });
    assert.deepEqual(sept.body, { owedGoingIn: 2500.5, givenInMonth: 500.5 });

    const today = todayIn('Asia/Kolkata');
    await as.admin.post('/v1/advances', { staffId: sita, givenOn: today, amount: 50, mode: 'cash' });
    const now = await as.admin.get(`/v1/staff/${sita}/advance-balance`);
    assert.deepEqual(now.body, { owedGoingIn: 750, givenInMonth: today.startsWith('2026-09') ? 750 : 50 });
  });

  it('keeps pay away from supervisors and workers', async () => {
    for (const who of ['supervisor', 'worker'] as const) {
      for (const res of [
        await as[who].get('/v1/advances'),
        await as[who].get(`/v1/staff/${ravi}/advance-balance`),
        await as[who].post('/v1/advances', { staffId: ravi, givenOn: '2026-09-01', amount: 10, mode: 'cash' }),
      ]) {
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'forbidden');
      }
    }
    const view = await as.viewAdmin.post('/v1/advances', { staffId: ravi, givenOn: '2026-09-01', amount: 10, mode: 'cash' });
    assert.equal(view.status, 403);
    assert.equal(view.body.error.details.action, 'advances.record');
  });

  it('deletes only for a super admin, audited, into the bin, off the balance', async () => {
    const [a] = (await as.admin.get('/v1/advances', { staffId: String(ravi), month: '2026-09' })).body;
    const refused = await as.admin.del(`/v1/advances/${a.id}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'super_admin_only');

    assert.equal((await as.superAdmin.del(`/v1/advances/${a.id}`)).status, 204);
    assert.equal((await as.superAdmin.del(`/v1/advances/${a.id}`)).status, 404);
    const sept = await as.admin.get(`/v1/staff/${ravi}/advance-balance`, { month: '2026-09' });
    assert.deepEqual(sept.body, { owedGoingIn: 2000, givenInMonth: 0 });

    const [audit] = await h.sql(`select * from audit_log where action = 'advances.delete'`);
    assert.equal(audit.entity_id, String(a.id));
    assert.equal(audit.before.amount, 500.5);
    const bin = await h.sql(`select kind, amount from vw_recycle_bin where property_id = $1 and id = $2`,
      [p.propertyId, a.id]);
    assert.deepEqual(bin, [{ kind: 'upad', amount: 500.5 }]);
  });

  it('cannot delete another property\'s advance', async () => {
    const other = await seedProperty(h);
    const staffId = await person('Elsewhere', other.propertyId);
    const [{ id }] = await h.sql(
      `insert into advances (property_id, staff_id, given_on, amount) values ($1, $2, '2026-09-01', 10) returning id`,
      [other.propertyId, staffId]);
    assert.equal((await as.superAdmin.del(`/v1/advances/${id}`)).status, 404);
    assert.ok(!(await as.admin.get('/v1/advances')).body.some((a: any) => a.id === id));
  });
});
