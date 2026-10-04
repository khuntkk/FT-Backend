import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { seedProperty, signInAll, startHarness, type Client, type Harness, type SeededProperty } from './helpers.ts';

let h: Harness;
let p: SeededProperty;
let as: Record<string, Client>;
let meena: number;
let ravi: number;
let sita: number;
let uday: number;
let idle: number;
let machine: number;
let dayShift: number;

async function person(name: string, salary: number, extra: Record<string, unknown> = {}, propertyId = p.propertyId) {
  const cols = ['property_id', 'name', 'monthly_salary', ...Object.keys(extra)];
  const [{ id }] = await h.sql(
    `insert into staff (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    [propertyId, name, salary, ...Object.values(extra)],
  );
  return id as number;
}

async function slip(date: string, crew: number[], o: { bonus: number; stitches: number; stitchBased?: boolean }) {
  const [{ id }] = await h.sql(
    `insert into production_entries (property_id, machine_id, work_date, shift_id, bonus_amount, total_stitches,
                                     is_stitch_based)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [p.propertyId, machine, date, dayShift, o.bonus, o.stitches, o.stitchBased ?? false],
  );
  for (const staffId of crew) {
    await h.sql(`insert into entry_karigars (property_id, entry_id, staff_id) values ($1, $2, $3)`,
      [p.propertyId, id, staffId]);
  }
}

const september = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

const rowOf = async (month: string, staffId: number) =>
  (await as.admin.get('/v1/payroll/preview', { month })).body.find((r: any) => r.staff.id === staffId);

const pay = (staffId: number, month: string, extra: Record<string, unknown> = {}) =>
  as.admin.post('/v1/payroll/payslips', { staffId, month, ...extra });

before(async () => {
  h = await startHarness();
  p = await seedProperty(h);
  as = await signInAll(h, p);
  await h.sql(`update property_settings set no_leave_bonus_amount = 500 where property_id = $1`, [p.propertyId]);
  meena = await person('Meena', 15000);
  ravi = await person('Ravi', 18000);
  sita = await person('Sita', 12000);
  uday = await person('Uday', 9000, { cut_salary_for_absent_days: false });
  idle = await person('Zed (left)', 9000, { is_active: false });
  [{ id: machine }] = await h.sql(`insert into machines (property_id, number) values ($1, 1) returning id`, [p.propertyId]);
  [{ id: dayShift }] = await h.sql(`select id from shifts where property_id = $1 and name = 'Day'`, [p.propertyId]);

  // Meena: every date of September a full present day.
  await as.admin.put('/v1/attendance/marks', { staffId: meena, dates: september, status: 'present' });
  // Ravi: nine marked days, a shared slip, two half days, and a stitch-based slip.
  await as.admin.put('/v1/attendance/marks', { staffId: ravi, dates: september.slice(0, 9), status: 'present' });
  await slip('2026-09-10', [ravi, sita], { bonus: 1000, stitches: 120000 });
  await as.admin.put('/v1/attendance/marks', { staffId: ravi, dates: ['2026-09-11', '2026-09-12'], status: 'halfDay' });
  await slip('2026-09-15', [ravi], { bonus: 300, stitches: 40000, stitchBased: true });
});
after(() => h.close());

describe('payroll preview', () => {
  it('has one row per active person, worked out from what is recorded', async () => {
    const res = await as.viewAdmin.get('/v1/payroll/preview', { month: '2026-09' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r: any) => r.staff.name), ['Meena', 'Ravi', 'Sita', 'Uday']);
    assert.equal(res.body[0].staff.monthlySalary, 15000, 'the Staff shape, with pay');
    assert.ok(!res.body.some((r: any) => r.staff.id === idle));
  });

  it('pays the no-leave bonus only for a full month present', async () => {
    const m = await rowOf('2026-09', meena);
    assert.deepEqual(m.breakdown, {
      perDayRate: 500, daysWorked: 30, baseAmount: 15000, bonusAmount: 0, noLeaveBonus: 500,
      advanceDeducted: 0, otherDeductions: 0, netPayable: 15500, salaryWasCut: true,
    });
    assert.equal(m.payment, null);
    assert.equal((await rowOf('2026-09', ravi)).breakdown.noLeaveBonus, 0);
  });

  it('counts half days as half, splits a bonus, and never counts a stitch-based slip as a day', async () => {
    const r = await rowOf('2026-09', ravi);
    assert.equal(r.breakdown.daysWorked, 11, '9 marked + 1 slip + 2 halves; the stitch-based slip adds none');
    assert.equal(r.breakdown.baseAmount, 6600);
    assert.equal(r.breakdown.bonusAmount, 800, 'half of 1000, plus the stitch-based 300');
    assert.equal(r.breakdown.netPayable, 7400);
    assert.equal(r.stitches, 160000);
    const s = await rowOf('2026-09', sita);
    assert.equal(s.breakdown.daysWorked, 1);
    assert.equal(s.breakdown.bonusAmount, 500);
  });

  it('keeps pay away from supervisors and workers', async () => {
    for (const who of ['supervisor', 'worker'] as const) {
      for (const res of [
        await as[who].get('/v1/payroll/preview', { month: '2026-09' }),
        await as[who].get('/v1/payroll/payslips'),
        await as[who].post('/v1/payroll/payslips', { staffId: ravi, month: '2026-09' }),
      ]) {
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'forbidden');
      }
    }
    const view = await as.viewAdmin.post('/v1/payroll/payslips', { staffId: ravi, month: '2026-09' });
    assert.equal(view.status, 403);
    assert.equal(view.body.error.details.action, 'payroll.mark_paid');
  });
});

describe('payslips', () => {
  it('records the server\'s own snapshot, paid now', async () => {
    const res = await pay(meena, '2026-09', { otherDeductions: 250, note: 'Uniform', netPayable: 1 });
    assert.equal(res.status, 200);
    const s = res.body;
    assert.equal(s.staffId, meena);
    assert.equal(s.periodStart, '2026-09-01');
    assert.equal(s.periodEnd, '2026-10-01');
    assert.equal(s.status, 'paid');
    assert.match(s.paidOn, /Z$/);
    assert.equal(s.otherDeductions, 250);
    assert.equal(s.netPayable, 15250);
    assert.equal(s.paidAmount, 15250);
    assert.equal(s.noLeaveBonus, 500);
    assert.equal(s.note, 'Uniform');
  });

  it('returns the payslip already recorded for that month', async () => {
    const [first] = (await as.admin.get('/v1/payroll/payslips', { staffId: String(meena) })).body;
    const again = await pay(meena, '2026-09', { otherDeductions: 9 });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first);
    assert.equal((await h.sql(`select count(*)::int as n from salary_payments where staff_id = $1`, [meena]))[0].n, 1);
  });

  it('shows a paid month from its payslip, never recomputed', async () => {
    await as.admin.put('/v1/attendance/mark', { staffId: meena, date: '2026-09-05', status: 'absent' });
    await h.sql(`update staff set monthly_salary = 30000 where id = $1`, [meena]);
    const m = await rowOf('2026-09', meena);
    assert.equal(m.breakdown.baseAmount, 15000);
    assert.equal(m.breakdown.daysWorked, 30);
    assert.equal(m.breakdown.netPayable, 15250);
    assert.equal(m.payment.netPayable, 15250);
  });

  it('refuses a negative deduction, an inactive person, and people not here', async () => {
    const neg = await pay(ravi, '2026-09', { otherDeductions: -5 });
    assert.equal(neg.status, 400);
    const inactive = await pay(idle, '2026-09');
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.details.fields.staffId, 'inactive');
    const other = await seedProperty(h);
    const elsewhere = await person('Elsewhere', 100, {}, other.propertyId);
    assert.equal((await pay(elsewhere, '2026-09')).status, 404);
  });

  it('lists by person and year, newest first', async () => {
    await pay(sita, '2026-08');
    await pay(sita, '2026-09');
    const list = (await as.viewAdmin.get('/v1/payroll/payslips', { staffId: String(sita), year: '2026' })).body;
    assert.deepEqual(list.map((s: any) => s.periodStart), ['2026-09-01', '2026-08-01']);
    assert.deepEqual((await as.viewAdmin.get('/v1/payroll/payslips', { year: '2025' })).body, []);
  });

  it('deletes only for a super admin, audited, into the bin', async () => {
    const [slip] = (await as.admin.get('/v1/payroll/payslips', { staffId: String(sita), year: '2026' })).body;
    const refused = await as.admin.del(`/v1/payroll/payslips/${slip.id}`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'super_admin_only');
    assert.equal((await as.superAdmin.del(`/v1/payroll/payslips/${slip.id}`)).status, 204);
    assert.equal((await as.superAdmin.del(`/v1/payroll/payslips/${slip.id}`)).status, 404);

    const [audit] = await h.sql(`select * from audit_log where action = 'payroll.delete_payslip'`);
    assert.equal(audit.entity_id, String(slip.id));
    assert.equal(audit.before.netPayable, slip.netPayable);
    const bin = await h.sql(`select kind from vw_recycle_bin where property_id = $1 and id = $2`, [p.propertyId, slip.id]);
    assert.deepEqual(bin, [{ kind: 'salaryPayment' }]);
    assert.equal((await rowOf('2026-09', sita)).payment, null);
  });
});

describe('upad recovery across months', () => {
  const balance = async (month?: string) =>
    (await as.admin.get(`/v1/staff/${uday}/advance-balance`, month ? { month } : undefined)).body;

  it('recovers what the packet allows, and owes the rest next month', async () => {
    await as.admin.post('/v1/advances', { staffId: uday, givenOn: '2026-08-05', amount: 12000, mode: 'cash' });

    const aug = await rowOf('2026-08', uday);
    assert.equal(aug.outstandingAdvance, 12000);
    assert.equal(aug.upadThisMonth, 12000);
    assert.equal(aug.breakdown.baseAmount, 9000, 'absent days not cut: the full salary');
    assert.equal(aug.breakdown.advanceDeducted, 9000);
    assert.equal(aug.breakdown.netPayable, 0);
    assert.equal(aug.advanceLeftAfter, 3000);

    const paid = await pay(uday, '2026-08');
    assert.equal(paid.body.advanceDeducted, 9000);
    assert.equal(paid.body.paidAmount, 0);

    const sept = await rowOf('2026-09', uday);
    assert.equal(sept.outstandingAdvance, 3000);
    assert.equal(sept.upadThisMonth, 0);
    assert.equal(sept.breakdown.advanceDeducted, 3000);
    assert.equal(sept.breakdown.netPayable, 6000);
    assert.equal(sept.advanceLeftAfter, 0);
    assert.deepEqual(await balance('2026-09'), { owedGoingIn: 3000, givenInMonth: 0 });
    assert.equal((await balance()).owedGoingIn, 3000);
  });

  it('owes it all again once the recovering payslip is deleted', async () => {
    const [aug] = (await as.admin.get('/v1/payroll/payslips', { staffId: String(uday) })).body;
    await as.superAdmin.del(`/v1/payroll/payslips/${aug.id}`);

    const sept = await rowOf('2026-09', uday);
    assert.equal(sept.outstandingAdvance, 12000);
    assert.equal(sept.breakdown.advanceDeducted, 9000);
    assert.equal(sept.advanceLeftAfter, 3000);
    assert.equal((await balance()).owedGoingIn, 12000);
    assert.equal((await rowOf('2026-08', uday)).payment, null);
  });
});
