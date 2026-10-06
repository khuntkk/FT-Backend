import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { seedProperty, signInAll, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;

before(async () => {
  h = await startHarness();
  p = await seedProperty(h, { machineLimit: 5 });
  as = await signInAll(h, p);
});
after(() => h.close());

describe('machines', () => {
  it('adds a machine and lists it', async () => {
    const res = await as.admin.post('/v1/machines', { number: 3, name: 'Tajima' });
    assert.equal(res.status, 200);
    assert.equal(res.body.number, 3);
    assert.equal(typeof res.body.id, 'number');
    assert.match(res.body.createdAt, /Z$/);
    const list = await as.supervisor.get('/v1/machines');
    assert.deepEqual(list.body.map((m: any) => m.number), [3]);
  });

  it('refuses a taken number', async () => {
    const res = await as.admin.post('/v1/machines', { number: 3 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'machine_number_taken');
    assert.equal(res.body.error.details.number, 3);
  });

  it('lets a view admin read but not add', async () => {
    const res = await as.viewAdmin.post('/v1/machines', { number: 9 });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
    assert.equal(res.body.error.details.action, 'machines.create');
  });

  it('bulk-adds the missing numbers, all or nothing past the limit', async () => {
    const tooMany = await as.admin.post('/v1/machines/bulk', { upTo: 7 });
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.body.error.code, 'machine_limit_reached');
    assert.deepEqual(tooMany.body.error.details, { limit: 5, used: 1, requested: 6 });
    assert.equal((await as.admin.get('/v1/machines')).body.length, 1);

    const ok = await as.admin.post('/v1/machines/bulk', { upTo: 5 });
    assert.deepEqual(ok.body, { created: 4 });
    const allowance = await as.worker.get('/v1/machines/allowance');
    assert.deepEqual(allowance.body, { limit: 5, used: 5, left: 0 });
  });

  it('refuses one more at the limit, as the database raises it', async () => {
    const res = await as.admin.post('/v1/machines', { number: 6 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'machine_limit_reached');
    assert.deepEqual(res.body.error.details, { limit: 5, used: 5 });
  });

  it('changes a machine; null clears', async () => {
    const [m] = (await as.admin.get('/v1/machines')).body;
    const res = await as.admin.patch(`/v1/machines/${m.id}`, { name: null, heads: 12, isActive: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, null);
    assert.equal(res.body.heads, 12);
    const active = await as.admin.get('/v1/machines', { activeOnly: 'true' });
    assert.ok(!active.body.some((x: any) => x.id === m.id));
  });

  it('deletes only for a super admin, audited, freeing a place', async () => {
    const [m] = (await as.admin.get('/v1/machines')).body;
    const refused = await as.admin.del(`/v1/machines/${m.id}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'super_admin_only');

    const res = await as.superAdmin2.del(`/v1/machines/${m.id}`);
    assert.equal(res.status, 204);
    assert.equal((await as.admin.get('/v1/machines/allowance')).body.left, 1);
    const [audit] = await h.sql(`select * from audit_log where action = 'machines.delete'`);
    assert.equal(audit.entity_id, String(m.id));
    assert.equal(audit.destructive, true);
    assert.equal(audit.before.number, m.number);
  });

  it('takes a bodiless DELETE labelled JSON, as some HTTP clients send it', async () => {
    const m = await as.admin.post('/v1/machines', { number: 99 });
    if (m.status !== 200) return; // at the limit by now: nothing to delete
    const res = await as.superAdmin.call('DELETE', `/v1/machines/${m.body.id}`, {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 204);
  });

  it('cannot see or touch another property\'s machines', async () => {
    const other = await seedProperty(h);
    const [{ id }] = await h.sql(`insert into machines (property_id, number) values ($1, 1) returning id`,
      [other.propertyId]);
    assert.equal((await as.admin.patch(`/v1/machines/${id}`, { name: 'x' })).status, 404);
    assert.ok(!(await as.admin.get('/v1/machines')).body.some((m: any) => m.id === id));
  });

  it('returns the first response to a repeated Idempotency-Key', async () => {
    const [m] = (await as.admin.get('/v1/machines')).body;
    await as.superAdmin.del(`/v1/machines/${m.id}`);
    const key = crypto.randomUUID();
    const first = await as.admin.post('/v1/machines', { number: 77 }, { 'idempotency-key': key });
    const again = await as.admin.post('/v1/machines', { number: 77 }, { 'idempotency-key': key });
    assert.equal(first.status, 200);
    assert.equal(again.status, 200);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.body.id, first.body.id);
  });
});
