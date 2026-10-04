// Ported case by case from packages/sf_core/test/payroll_calculator_test.dart
// (the calculateSalary, money and payslip groups; ProductionTotals and
// DateSpan belong to other modules).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SalaryPayment } from '@stitchflow/contract';
import { advanceLeftAfter, breakdownFromPayment, calculateSalary, type PayRules } from '../src/domain/payroll.ts';

const staffWith = (o: Partial<PayRules> = {}): PayRules => ({
  monthlySalary: 18000, payDaysPerMonth: 30, cutSalaryForAbsentDays: true, ...o,
});

const gross = (b: { baseAmount: number; bonusAmount: number; noLeaveBonus: number }) =>
  b.baseAmount + b.bonusAmount + b.noLeaveBonus;

const close = (actual: number, expected: number, within: number) =>
  assert.ok(Math.abs(actual - expected) <= within, `${actual} is not within ${within} of ${expected}`);

describe('calculateSalary', () => {
  it('pays the day rate for every day worked', () => {
    const r = calculateSalary({ staff: staffWith(), daysWorked: 26 });
    assert.equal(r.perDayRate, 600, '18000 / 30');
    assert.equal(r.baseAmount, 15600);
    assert.equal(r.netPayable, 15600);
  });

  it('half days count as half a day of pay', () => {
    const r = calculateSalary({ staff: staffWith(), daysWorked: 26 });
    const withHalves = calculateSalary({ staff: staffWith(), daysWorked: 25.0 });
    assert.equal(r.baseAmount - withHalves.baseAmount, 600);
    assert.equal(calculateSalary({ staff: staffWith(), daysWorked: 25.5 }).baseAmount, 15300);
  });

  it('a full month earns the whole salary', () => {
    assert.equal(calculateSalary({ staff: staffWith(), daysWorked: 30 }).baseAmount, 18000);
  });

  it('honours a pay-days divisor other than 30', () => {
    const r = calculateSalary({ staff: staffWith({ payDaysPerMonth: 26 }), daysWorked: 26 });
    close(r.perDayRate, 692.31, 0.01);
    close(r.baseAmount, 18000, 0.01);
  });

  it('staff exempt from cuts keep the full salary on short months', () => {
    const r = calculateSalary({ staff: staffWith({ cutSalaryForAbsentDays: false }), daysWorked: 12 });
    assert.equal(r.baseAmount, 18000);
    assert.equal(r.salaryWasCut, false);
  });

  it('bonus is added on top of attendance pay', () => {
    const r = calculateSalary({ staff: staffWith(), daysWorked: 30, bonusEarned: 2500 });
    assert.equal(r.baseAmount, 18000);
    assert.equal(r.bonusAmount, 2500);
    assert.equal(gross(r), 20500);
  });

  it('stitches alone never change base pay', () => {
    const noWork = calculateSalary({ staff: staffWith(), daysWorked: 0 });
    assert.equal(noWork.baseAmount, 0);
    assert.equal(noWork.netPayable, 0);
  });

  it('recovers only as much advance as the packet allows', () => {
    const r = calculateSalary({ staff: staffWith(), daysWorked: 10, outstandingAdvance: 25000 });
    assert.equal(r.baseAmount, 6000);
    assert.equal(r.advanceDeducted, 6000);
    assert.equal(r.netPayable, 0, 'pay must never go negative');
  });

  it('recovers the full advance when the packet covers it', () => {
    const r = calculateSalary({ staff: staffWith(), daysWorked: 30, outstandingAdvance: 5000 });
    assert.equal(r.advanceDeducted, 5000);
    assert.equal(r.netPayable, 13000);
  });

  it('other deductions come out before advance recovery', () => {
    const r = calculateSalary({
      staff: staffWith(), daysWorked: 10, outstandingAdvance: 9000, otherDeductions: 2000,
    });
    assert.equal(r.otherDeductions, 2000);
    assert.equal(r.advanceDeducted, 4000, '6000 gross less 2000 deductions');
    assert.equal(r.netPayable, 0);
  });

  it('falls back to 30 pay days if the divisor is nonsense', () => {
    const r = calculateSalary({ staff: staffWith({ payDaysPerMonth: 0 }), daysWorked: 30 });
    assert.equal(r.baseAmount, 18000);
  });

  // Not in the Dart file: the two branches the API relies on beyond it.
  it('recovers nothing when deductions already exceed the gross', () => {
    const r = calculateSalary({
      staff: staffWith(), daysWorked: 1, outstandingAdvance: 500, otherDeductions: 1000,
    });
    assert.equal(r.advanceDeducted, 0);
    assert.equal(r.netPayable, 0);
  });

  it('adds the no-leave bonus to the gross', () => {
    const r = calculateSalary({ staff: staffWith(), daysWorked: 30, noLeaveBonus: 500 });
    assert.equal(r.noLeaveBonus, 500);
    assert.equal(r.netPayable, 18500);
  });
});

describe('money is held to the paisa', () => {
  it('an uneven day rate still pays a round amount', () => {
    const r = calculateSalary({ staff: staffWith({ monthlySalary: 17000 }), daysWorked: 26 });
    assert.equal(r.baseAmount, 14733.33, '17000 / 30 × 26, not 14733.333…');
    close(r.perDayRate, 566.667, 0.001);
  });

  it('a split bonus rounds too', () => {
    const r = calculateSalary({ staff: staffWith(), daysWorked: 30, bonusEarned: 100 / 3 });
    assert.equal(r.bonusAmount, 33.33);
    assert.equal(r.netPayable, 18033.33);
  });
});

describe('a payslip as it was paid', () => {
  it('reads back exactly, no-leave bonus apart', () => {
    const p: SalaryPayment = {
      id: 1, staffId: 1, periodStart: '2026-03-01', periodEnd: '2026-04-01',
      daysWorked: 31, perDayRate: 600, stitchesInPeriod: 0,
      baseAmount: 18000, bonusAmount: 1200, noLeaveBonus: 500, salaryWasCut: true,
      advanceDeducted: 2000, otherDeductions: 0, netPayable: 17700, paidAmount: 17700,
      status: 'paid', paidOn: '2026-04-01T10:00:00.000Z', note: null,
    };
    const b = breakdownFromPayment(p);
    assert.equal(b.noLeaveBonus, 500);
    assert.equal(gross(b), 19700);
    assert.equal(b.netPayable, 17700);
  });

  it('what is left owing after the payslip never goes below zero', () => {
    assert.equal(advanceLeftAfter(5000, 2000), 3000);
    assert.equal(advanceLeftAfter(1000, 1000), 0);
    assert.equal(advanceLeftAfter(100.333, 0), 100.33);
  });
});
