import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { seedProperty, signInAll, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;
let day: number;
let night: number;
const m: Record<number, number> = {};
let ravi: number;
let sita: number;
let mohan: number;
let designer: number;

const insertStaff = async (name: string, category = 'karigar') =>
  (await h.sql(`insert into staff (property_id, name, category, monthly_salary) values ($1, $2, $3, 15000) returning id`,
    [p.propertyId, name, category]))[0].id as number;

const draft = (over: Record<string, unknown> = {}) => ({
  machineId: m[1], workDate: '2026-09-10', shiftId: day, totalStitches: 180000, embMinutes: 600,
  stopMinutes: 60, threadBreaks: 4, frames: 3, hasHeadLoss: false, isStitchBased: false,
  bonusAmount: 0, bonusIsManual: false, karigars: [{ staffId: ravi, isHalfDay: false }], ...over,
});

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
  const shifts = await h.sql(`select id, name from shifts where property_id = $1`, [p.propertyId]);
  day = shifts.find((s) => s.name === 'Day').id;
  night = shifts.find((s) => s.name === 'Night').id;
  for (const n of [1, 2, 3]) {
    m[n] = (await h.sql(`insert into machines (property_id, number) values ($1, $2) returning id`, [p.propertyId, n]))[0].id;
  }
  ravi = await insertStaff('Ravi');
  sita = await insertStaff('Sita');
  mohan = await insertStaff('Mohan');
  designer = await insertStaff('Dev', 'designer');
  // 1.0 per 1,000 under 100k, 1.5 to 200k, 2.0 above; head loss pays a flat 80.
  const rules = [
    { name: 'Full head', isActive: true, condition: 'fullHead', kind: 'perThousandSlab', sortOrder: 0,
      slabs: [{ fromStitches: 0, toStitches: 100000, value: 1 }, { fromStitches: 100000, toStitches: 200000, value: 1.5 },
        { fromStitches: 200000, toStitches: null, value: 2 }] },
    { name: 'Head loss', isActive: true, condition: 'headLoss', kind: 'fixedSlab', sortOrder: 1,
      slabs: [{ fromStitches: 0, toStitches: null, value: 80 }] },
  ];
  for (const r of rules) assert.equal((await as.admin.post('/v1/bonus-rules', r)).status, 200);
});
after(() => h.close());

describe('recording a slip', () => {
  it('works out the bonus on the server, ignoring the app\'s preview', async () => {
    const res = await as.worker.put('/v1/production/entry', draft({
      bonusAmount: 9999, karigars: [{ staffId: ravi, isHalfDay: false }, { staffId: sita, isHalfDay: true }],
    }));
    assert.equal(res.status, 200);
    assert.equal(res.body.entry.bonusAmount, 270, '180k x 1.5');
    assert.equal(res.body.entry.bonusIsManual, false);
    assert.equal(res.body.bonusPerKarigar, 135);
    assert.equal(res.body.entry.workDate, '2026-09-10');
    assert.match(res.body.entry.createdAt, /Z$/);
    assert.deepEqual(res.body.karigars.map((k: any) => [k.staff.name, k.isHalfDay]), [['Ravi', false], ['Sita', true]]);
    assert.deepEqual(Object.keys(res.body.karigars[0].staff).sort(),
      ['allowHalfDay', 'category', 'code', 'id', 'isActive', 'name', 'photoFileId'], 'a Person: no pay');
  });

  it('keeps a bonus typed by hand (by someone who may see pay), split to the paisa', async () => {
    const res = await as.admin.put('/v1/production/entry', draft({
      machineId: m[2], bonusAmount: 500.5, bonusIsManual: true,
      karigars: [{ staffId: ravi, isHalfDay: false }, { staffId: sita, isHalfDay: false }, { staffId: mohan, isHalfDay: false }],
    }));
    assert.equal(res.status, 200);
    assert.equal(res.body.entry.bonusAmount, 500.5);
    assert.equal(res.body.entry.bonusIsManual, true);
    assert.equal(res.body.bonusPerKarigar, 166.83);
  });

  it('pays the head-loss rule when head loss is ticked', async () => {
    const res = await as.worker.put('/v1/production/entry', draft({ machineId: m[3], hasHeadLoss: true }));
    assert.equal(res.body.entry.bonusAmount, 80);
  });

  it('pays a stitch-based slip at the settings rate, only while it is switched on', async () => {
    const slip = draft({ machineId: m[3], shiftId: night, isStitchBased: true });
    assert.equal((await as.worker.put('/v1/production/entry', slip)).body.entry.bonusAmount, 0);
    await h.sql(`update property_settings set stitch_based_enabled = true, stitch_based_rate_per_thousand = 0.8
                 where property_id = $1`, [p.propertyId]);
    const res = await as.worker.put('/v1/production/entry', slip);
    assert.equal(res.body.entry.bonusAmount, 144, '180k x 0.8, not the rule\'s 270');
    assert.equal(res.body.entry.isStitchBased, true);
  });

  it('saving the slot again overwrites it and replaces its operators', async () => {
    const first = await as.worker.get('/v1/production/entry', { machineId: String(m[1]), date: '2026-09-10', shiftId: String(day) });
    const res = await as.worker.put('/v1/production/entry', draft({
      totalStitches: 50000, karigars: [{ staffId: mohan, isHalfDay: false }],
    }));
    assert.equal(res.body.entry.id, first.body.entry.id);
    assert.equal(res.body.entry.bonusAmount, 50);
    assert.deepEqual(res.body.karigars.map((k: any) => k.staff.id), [mohan]);
  });

  it('refuses a view admin', async () => {
    const res = await as.viewAdmin.put('/v1/production/entry', draft());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
    assert.equal(res.body.error.details.action, 'production.record');
  });
});

describe('what a slip must hold', () => {
  const refused = async (over: Record<string, unknown>) => {
    const res = await as.worker.put('/v1/production/entry', draft({ workDate: '2026-09-20', ...over }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    return res.body.error.details.fields;
  };

  it('only operators, and only live ones', async () => {
    const gone = await insertStaff('Gone');
    await h.sql(`update staff set deleted_at = now() where id = $1`, [gone]);
    const fields = await refused({
      karigars: [{ staffId: ravi, isHalfDay: false }, { staffId: designer, isHalfDay: false }, { staffId: gone, isHalfDay: false }],
    });
    assert.deepEqual(fields, { 'karigars[1].staffId': 'notKarigar', 'karigars[2].staffId': 'notKarigar' });
  });

  it('emb and stop time within the shift version\'s length', async () => {
    assert.deepEqual(await refused({ embMinutes: 700, stopMinutes: 21 }), { embMinutes: 'overShift', stopMinutes: 'overShift' });
    const ok = await as.worker.put('/v1/production/entry', draft({ workDate: '2026-09-20', embMinutes: 700, stopMinutes: 20 }));
    assert.equal(ok.status, 200);
  });

  it('a shift version in effect on the date', async () => {
    assert.deepEqual(await refused({ workDate: '2025-12-31' }), { shiftId: 'notInEffect' });
  });

  it('a live machine, of this unit', async () => {
    const [{ id: binned }] = await h.sql(
      `insert into machines (property_id, number, deleted_at) values ($1, 40, now()) returning id`, [p.propertyId]);
    assert.deepEqual(await refused({ machineId: binned }), { machineId: 'notFound' });
    const other = await seedProperty(h);
    const [{ id: theirs }] = await h.sql(`insert into machines (property_id, number) values ($1, 1) returning id`, [other.propertyId]);
    assert.deepEqual(await refused({ machineId: theirs }), { machineId: 'notFound' });
  });
});

describe('reading slips', () => {
  it('lists every live, active machine for a shift, with its slip or null', async () => {
    await h.sql(`insert into machines (property_id, number, is_active) values ($1, 9, false)`, [p.propertyId]);
    const res = await as.worker.get('/v1/production/day', { date: '2026-09-10', shiftId: String(day) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((d: any) => d.machine.number), [1, 2, 3]);
    assert.deepEqual(res.body.map((d: any) => d.entry?.entry.totalStitches ?? null), [50000, 180000, 180000]);
    const empty = await as.worker.get('/v1/production/day', { date: '2026-09-11', shiftId: String(day) });
    assert.ok(empty.body.every((d: any) => d.entry === null));
  });

  it('404s an empty slot', async () => {
    const res = await as.worker.get('/v1/production/entry', { machineId: String(m[1]), date: '2026-09-11', shiftId: String(day) });
    assert.equal(res.status, 404);
  });
});

describe('deleting a slip', () => {
  it('is a super admin\'s, audited, and the slot is reused from the bin', async () => {
    const slot = { machineId: String(m[2]), date: '2026-09-10', shiftId: String(day) };
    const { body: slip } = await as.admin.get('/v1/production/entry', slot);

    const refused = await as.admin.del(`/v1/production/entry/${slip.entry.id}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'super_admin_only');

    assert.equal((await as.superAdmin2.del(`/v1/production/entry/${slip.entry.id}`)).status, 204);
    assert.equal((await as.admin.get('/v1/production/entry', slot)).status, 404);
    const [audit] = await h.sql(`select * from audit_log where action = 'production.delete'`);
    assert.equal(audit.entity_id, String(slip.entry.id));
    assert.equal(audit.before.entry.totalStitches, 180000);
    const [binned] = await h.sql(`select deleted_at, deleted_batch from production_entries where id = $1`, [slip.entry.id]);
    assert.ok(binned.deleted_at && binned.deleted_batch, 'soft deleted, with a batch for the bin');

    const res = await as.worker.put('/v1/production/entry', draft({ machineId: m[2], totalStitches: 10000 }));
    assert.equal(res.body.entry.id, slip.entry.id, 'the binned row is brought back');
    assert.equal(res.body.entry.bonusAmount, 10, 'and worked out afresh, no longer manual');
    assert.deepEqual(res.body.karigars.map((k: any) => k.staff.id), [ravi]);
    const [row] = await h.sql(`select deleted_at, deleted_batch from production_entries where id = $1`, [slip.entry.id]);
    assert.equal(row.deleted_at, null);
    assert.equal(row.deleted_batch, null);
  });

  it('cannot touch another property\'s slip', async () => {
    const other = await seedProperty(h);
    const [{ id: mc }] = await h.sql(`insert into machines (property_id, number) values ($1, 1) returning id`, [other.propertyId]);
    const [{ id: sh }] = await h.sql(`select id from shifts where property_id = $1 limit 1`, [other.propertyId]);
    const [{ id }] = await h.sql(
      `insert into production_entries (property_id, machine_id, work_date, shift_id) values ($1, $2, '2026-09-10', $3) returning id`,
      [other.propertyId, mc, sh]);
    assert.equal((await as.superAdmin.del(`/v1/production/entry/${id}`)).status, 404);
  });
});

describe('slips over a range', () => {
  before(async () => {
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
      await as.worker.put('/v1/production/entry', draft({
        workDate: d, shiftId: night, totalStitches: 10000, embMinutes: 360, stopMinutes: 0, threadBreaks: 1, frames: 1,
        karigars: [{ staffId: sita, isHalfDay: false }],
      }));
    }
  });

  it('pages newest first with an opaque cursor', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: Record<string, string> = { from: '2026-09-01', to: '2026-09-30', limit: '3' };
      if (cursor) query.cursor = cursor;
      const res = await as.worker.get('/v1/production/entries', query);
      assert.equal(res.status, 200);
      assert.ok(res.body.items.length <= 3);
      seen.push(...res.body.items.map((i: any) => i.entry.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    const all = await as.worker.get('/v1/production/entries', { from: '2026-09-01', to: '2026-09-30' });
    assert.equal(all.body.nextCursor, null);
    assert.deepEqual(seen, all.body.items.map((i: any) => i.entry.id));
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(pages, Math.ceil(seen.length / 3));
    const dates = all.body.items.map((i: any) => i.entry.workDate);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  it('filters by shift and by operator; the end date is included', async () => {
    const bySita = await as.worker.get('/v1/production/entries',
      { from: '2026-09-01', to: '2026-09-05', staffId: String(sita), shiftId: String(night) });
    assert.equal(bySita.body.items.length, 5);
    const oneDay = await as.worker.get('/v1/production/entries', { from: '2026-09-05', to: '2026-09-05' });
    assert.equal(oneDay.body.items.length, 1);
  });

  it('refuses a bad limit or cursor', async () => {
    const big = await as.worker.get('/v1/production/entries', { from: '2026-09-01', to: '2026-09-30', limit: '501' });
    assert.equal(big.status, 400);
    assert.deepEqual(big.body.error.details.fields, { limit: 'range' });
    const bad = await as.worker.get('/v1/production/entries', { from: '2026-09-01', to: '2026-09-30', cursor: 'nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.fields, { cursor: 'invalid' });
  });

  it('totals a range against each slip\'s shift length', async () => {
    const res = await as.worker.get('/v1/production/totals', { from: '2026-09-01', to: '2026-09-05' });
    assert.deepEqual(res.body, {
      stitches: 50000, embMinutes: 1800, stopMinutes: 0, threadBreaks: 5, frames: 5, entryCount: 5,
      machineCount: 1, shiftMinutes: 3600, utilisation: 0.5, accountedFor: 0.5, averagePerEntry: 10000,
    });
    const none = await as.worker.get('/v1/production/totals', { from: '2026-08-01', to: '2026-08-31' });
    assert.deepEqual(none.body, {
      stitches: 0, embMinutes: 0, stopMinutes: 0, threadBreaks: 0, frames: 0, entryCount: 0,
      machineCount: 0, shiftMinutes: 0, utilisation: null, accountedFor: null, averagePerEntry: 0,
    });
  });

  it('totals a month per day, leaving out empty days', async () => {
    const res = await as.worker.get('/v1/production/daily-totals', { month: '2026-09', shiftId: String(night) });
    assert.deepEqual(Object.keys(res.body).sort(),
      ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-10']);
    assert.equal(res.body['2026-09-01'].stitches, 10000);
    assert.equal(res.body['2026-09-01'].utilisation, 0.5);
  });
});

describe('report scans', () => {
  let fileId: string;
  before(async () => {
    [{ id: fileId }] = await h.sql(
      `insert into files (property_id, purpose, storage_key, content_type, byte_size, sha256)
       values ($1, 'slipPhoto', $2, 'image/jpeg', 10, $3) returning id`,
      [p.propertyId, `k-${Date.now()}`, 'a'.repeat(64)]);
  });

  it('keeps a scan and links it to the slip it filled', async () => {
    const scan = await as.worker.post('/v1/production/scans', {
      machineId: m[1], photoFileId: fileId, engine: 'mlkitLatin',
      lines: [{ text: 'STITCH 12000', left: 1, top: 2, right: 3, bottom: 4 }],
      reading: { totalStitches: { value: 12000, confidence: 0.9, source: 'STITCH 12000' } },
    });
    assert.equal(scan.status, 200);
    assert.equal(typeof scan.body.id, 'number');
    const saved = await as.worker.put('/v1/production/entry', draft({ workDate: '2026-09-21', scanId: scan.body.id }));
    assert.equal(saved.status, 200);
    const [row] = await h.sql(`select entry_id, lines, reading from slip_scans where id = $1`, [scan.body.id]);
    assert.equal(row.entry_id, saved.body.entry.id);
    assert.equal(row.lines[0].text, 'STITCH 12000');
  });

  it('refuses an unknown photo, and a scan of another machine on a slip', async () => {
    const res = await as.worker.post('/v1/production/scans', {
      machineId: m[1], photoFileId: crypto.randomUUID(), engine: 'mlkitLatin', lines: [], reading: {},
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.fields, { photoFileId: 'notFound' });
    const scan = await as.worker.post('/v1/production/scans', {
      machineId: m[3], photoFileId: fileId, engine: 'mlkitLatin', lines: [], reading: {},
    });
    const slip = await as.worker.put('/v1/production/entry', draft({ workDate: '2026-09-22', scanId: scan.body.id }));
    assert.equal(slip.status, 400);
    assert.deepEqual(slip.body.error.details.fields, { scanId: 'notFound' });
  });
});
