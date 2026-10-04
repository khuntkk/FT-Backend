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

const ladderRule = (over: Record<string, unknown> = {}) => ({
  name: 'Full head', isActive: true, condition: 'fullHead', kind: 'perThousandSlab',
  // Out of order on purpose: the ladder comes back by fromStitches.
  slabs: [
    { fromStitches: 200000, toStitches: null, value: 2 },
    { fromStitches: 0, toStitches: 100000, value: 1 },
    { fromStitches: 100000, toStitches: 200000, value: 1.5 },
  ],
  ...over,
});

describe('bonus rules', () => {
  let fullHead: any;

  it('adds a rule with its ladder', async () => {
    const res = await as.admin.post('/v1/bonus-rules', ladderRule({ sortOrder: 2 }));
    assert.equal(res.status, 200);
    fullHead = res.body;
    assert.equal(fullHead.flatAmount, 0);
    assert.equal(fullHead.sortOrder, 2);
    assert.deepEqual(fullHead.slabs.map((s: any) => [s.fromStitches, s.toStitches, s.value]),
      [[0, 100000, 1], [100000, 200000, 1.5], [200000, null, 2]]);
    assert.equal(typeof fullHead.slabs[0].id, 'number');
  });

  it('lists rules in matching order: sort order, then id', async () => {
    const a = await as.admin.post('/v1/bonus-rules', ladderRule({ name: 'A', sortOrder: 1 }));
    const b = await as.admin.post('/v1/bonus-rules', ladderRule({ name: 'B', sortOrder: 1 }));
    const res = await as.viewAdmin.get('/v1/bonus-rules');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r: any) => r.id), [a.body.id, b.body.id, fullHead.id]);
    assert.equal(res.body[2].slabs.length, 3);
  });

  it('refuses a broken ladder with every problem', async () => {
    const gap = await as.admin.post('/v1/bonus-rules', ladderRule({
      slabs: [{ fromStitches: 0, toStitches: 100000, value: 1 }, { fromStitches: 120000, toStitches: null, value: 2 }],
    }));
    assert.equal(gap.status, 409);
    assert.equal(gap.body.error.code, 'slab_ladder_invalid');
    assert.deepEqual(gap.body.error.details.problems, [
      { kind: 'gap', fromStitches: 0, toStitches: 100000, nextFromStitches: 120000, nextToStitches: null },
    ]);

    const empty = await as.admin.post('/v1/bonus-rules', ladderRule({ slabs: [] }));
    assert.equal(empty.status, 409);
    assert.deepEqual(empty.body.error.details.problems.map((x: any) => x.kind), ['empty']);

    const overlap = await as.admin.put(`/v1/bonus-rules/${fullHead.id}`, ladderRule({
      slabs: [{ fromStitches: 0, toStitches: 150000, value: 1 }, { fromStitches: 100000, toStitches: null, value: 2 }],
    }));
    assert.equal(overlap.status, 409);
    assert.deepEqual(overlap.body.error.details.problems.map((x: any) => x.kind), ['overlap']);
    assert.equal((await as.admin.get(`/v1/bonus-rules/${fullHead.id}`)).body.slabs.length, 3, 'nothing changed');
  });

  it('a per-frame rule needs no ladder and keeps none', async () => {
    const res = await as.admin.post('/v1/bonus-rules', {
      name: 'Frames', isActive: true, condition: 'headLoss', kind: 'perFrame', ratePerFrame: 12.5,
      slabs: [{ fromStitches: 0, toStitches: 10, value: 1 }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ratePerFrame, 12.5);
    assert.deepEqual(res.body.slabs, []);
  });

  it('replaces a rule and its whole ladder, keeping its place when sortOrder is left out', async () => {
    const res = await as.admin.put(`/v1/bonus-rules/${fullHead.id}`, {
      name: '  Flat plus  ', isActive: true, condition: 'fullHead', kind: 'flatPlusSlab', flatAmount: 100,
      slabs: [{ fromStitches: 0, toStitches: null, value: 3 }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Flat plus');
    assert.equal(res.body.kind, 'flatPlusSlab');
    assert.equal(res.body.flatAmount, 100);
    assert.equal(res.body.sortOrder, 2);
    assert.deepEqual(res.body.slabs.map((s: any) => [s.fromStitches, s.toStitches, s.value]), [[0, null, 3]]);
    const [{ n }] = await h.sql(`select count(*)::int as n from bonus_slabs where rule_id = $1`, [fullHead.id]);
    assert.equal(n, 1);
  });

  it('switches a rule off and on', async () => {
    const off = await as.admin.patch(`/v1/bonus-rules/${fullHead.id}`, { isActive: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.isActive, false);
    const on = await as.admin.patch(`/v1/bonus-rules/${fullHead.id}`, { isActive: true });
    assert.equal(on.body.isActive, true);
  });

  it('is never shown to a supervisor or an operator, and a view admin cannot change it', async () => {
    for (const who of ['supervisor', 'worker']) {
      const res = await as[who].get('/v1/bonus-rules');
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
      assert.equal(res.body.error.details.action, 'bonus_rules.view');
    }
    const res = await as.viewAdmin.patch(`/v1/bonus-rules/${fullHead.id}`, { isActive: false });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.details.action, 'bonus_rules.save');
  });

  it('deletes only for a super admin, audited', async () => {
    const refused = await as.admin.del(`/v1/bonus-rules/${fullHead.id}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'super_admin_only');

    assert.equal((await as.superAdmin.del(`/v1/bonus-rules/${fullHead.id}`)).status, 204);
    assert.equal((await as.admin.get(`/v1/bonus-rules/${fullHead.id}`)).status, 404);
    assert.ok(!(await as.admin.get('/v1/bonus-rules')).body.some((r: any) => r.id === fullHead.id));
    const [audit] = await h.sql(`select * from audit_log where action = 'bonus_rules.delete'`);
    assert.equal(audit.entity_id, String(fullHead.id));
    assert.equal(audit.destructive, true);
    assert.equal(audit.before.name, 'Flat plus');
    assert.equal(audit.before.slabs.length, 1);
    assert.equal((await as.admin.put(`/v1/bonus-rules/${fullHead.id}`, ladderRule())).status, 404);
  });

  it('cannot see or touch another property\'s rules', async () => {
    const other = await seedProperty(h);
    const [{ id }] = await h.sql(`insert into bonus_rules (property_id, name) values ($1, 'Theirs') returning id`,
      [other.propertyId]);
    assert.equal((await as.admin.get(`/v1/bonus-rules/${id}`)).status, 404);
    assert.equal((await as.admin.patch(`/v1/bonus-rules/${id}`, { isActive: false })).status, 404);
    assert.equal((await as.superAdmin.del(`/v1/bonus-rules/${id}`)).status, 404);
    assert.ok(!(await as.admin.get('/v1/bonus-rules')).body.some((r: any) => r.id === id));
  });
});
