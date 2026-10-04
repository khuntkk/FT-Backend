// Pay arithmetic, ported from calculateSalary() in
// packages/sf_core/lib/src/domain/payroll_calculator.dart in the apps repo.
// Pure functions: what a month's pay is worked out *from* comes from
// fn_payroll_inputs and fn_advance_outstanding (HANDOVER §7); the sums are here.

import { roundMoney, type SalaryBreakdown, type SalaryPayment, type Staff } from '@stitchflow/contract';

/** The fields of a person the calculation reads. */
export type PayRules = Pick<Staff, 'monthlySalary' | 'payDaysPerMonth' | 'cutSalaryForAbsentDays'>;

export interface SalaryInput {
  staff: PayRules;
  /** Days credited; half days count 0.5. */
  daysWorked: number;
  bonusEarned?: number;
  noLeaveBonus?: number;
  outstandingAdvance?: number;
  otherDeductions?: number;
  /** A fixed amount to recover instead of "as much as the packet allows". */
  advanceToRecover?: number;
}

/** Gross less deductions, rounded to the paisa. Never negative: a deduction
 * larger than the gross stays outstanding rather than becoming negative pay. */
export function netPayable(b: Omit<SalaryBreakdown, 'netPayable'>): number {
  const net = roundMoney(b.baseAmount + b.bonusAmount + b.noLeaveBonus - (b.advanceDeducted + b.otherDeductions));
  return net < 0 ? 0 : net;
}

/**
 * One person's pay for a period.
 *
 * Base pay comes from hajari: the monthly salary divided by payDaysPerMonth,
 * times the days credited. Someone whose absent days are not cut keeps the
 * full monthly amount however many days they came in. Stitches never touch
 * base pay — they earn bonus, which arrives already totalled.
 */
export function calculateSalary(input: SalaryInput): SalaryBreakdown {
  const { staff, daysWorked } = input;
  // Guard against a zero or nonsensical divisor.
  const payDays = staff.payDaysPerMonth > 0 ? staff.payDaysPerMonth : 30;
  const perDay = staff.monthlySalary / payDays;

  const cut = staff.cutSalaryForAbsentDays;
  // The day rate is left exact; only amounts of money are rounded, so 26
  // days at 17000/30 is 14733.33 rather than 26 × 566.67 = 14733.42.
  const base = roundMoney(cut ? perDay * daysWorked : staff.monthlySalary);
  const bonus = roundMoney(input.bonusEarned ?? 0);
  const noLeave = roundMoney(input.noLeaveBonus ?? 0);
  const deductions = roundMoney(input.otherDeductions ?? 0);

  // Other deductions come out first; the advance takes only what is left.
  const recoverable = base + bonus + noLeave - deductions;
  const outstanding = input.outstandingAdvance ?? 0;
  const advance = roundMoney(input.advanceToRecover ?? Math.min(outstanding, recoverable));

  const breakdown = {
    perDayRate: perDay,
    daysWorked,
    baseAmount: base,
    bonusAmount: bonus,
    noLeaveBonus: noLeave,
    advanceDeducted: advance < 0 ? 0 : advance,
    otherDeductions: deductions,
    salaryWasCut: cut,
  };
  return { ...breakdown, netPayable: netPayable(breakdown) };
}

/** A payslip as it was paid, rather than as it would work out today. */
export const breakdownFromPayment = (p: SalaryPayment): SalaryBreakdown => ({
  perDayRate: p.perDayRate,
  daysWorked: p.daysWorked,
  baseAmount: p.baseAmount,
  bonusAmount: p.bonusAmount,
  noLeaveBonus: p.noLeaveBonus,
  advanceDeducted: p.advanceDeducted,
  otherDeductions: p.otherDeductions,
  netPayable: netPayable(p),
  salaryWasCut: p.salaryWasCut,
});

/** What is still owed once this month's payslip has taken its share. */
export function advanceLeftAfter(outstanding: number, deducted: number): number {
  const left = outstanding - deducted;
  return left <= 0 ? 0 : roundMoney(left);
}
