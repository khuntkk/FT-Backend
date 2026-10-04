// Payroll — salary preview and payslips (API.md §3 Payroll).
//
// What a month's pay is worked out from comes from fn_payroll_inputs, one
// query for the whole unit; the arithmetic is domain/payroll.ts. A paid month
// is read back from its payslip, never recomputed: attendance corrected or a
// salary raised afterwards must not move what was handed over.

import type { Month, PayrollRow, PayslipInput, SalaryBreakdown, SalaryPayment, Staff } from '@stitchflow/contract';
import { monthRange, roundMoney } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { invalid, notFound } from '../http/errors.ts';
import type { Member } from '../http/types.ts';
import { advanceLeftAfter, breakdownFromPayment, calculateSalary } from '../domain/payroll.ts';
import { STAFF_COLUMNS } from './shapes.ts';

/** From salary_payments p. */
const PAYMENT_COLUMNS = `
  p.id, p.staff_id as "staffId", p.period_start as "periodStart", p.period_end as "periodEnd",
  p.days_worked as "daysWorked", p.per_day_rate as "perDayRate", p.stitches_in_period as "stitchesInPeriod",
  p.base_amount as "baseAmount", p.bonus_amount as "bonusAmount", p.no_leave_bonus as "noLeaveBonus",
  p.salary_was_cut as "salaryWasCut", p.advance_deducted as "advanceDeducted",
  p.other_deductions as "otherDeductions", p.net_payable as "netPayable", p.paid_amount as "paidAmount",
  p.status, p.paid_on as "paidOn", p.note`;

/** One person's row of fn_payroll_inputs, with the person. */
interface Inputs {
  staff: Staff;
  daysWorked: number;
  everyDayPresent: boolean;
  bonusEarned: number;
  stitches: number;
  advanceOutstanding: number;
  advanceGiven: number;
  paymentId: number | null;
  noLeaveBonusAmount: number;
}

const INPUT_COLUMNS = `
  i.days_worked as "daysWorked", i.every_day_present as "everyDayPresent", i.bonus_earned as "bonusEarned",
  i.stitches, i.advance_outstanding as "advanceOutstanding", i.advance_given as "advanceGiven",
  i.payment_id as "paymentId", ps.no_leave_bonus_amount as "noLeaveBonusAmount"`;

async function inputs(tx: Tx, member: Member, month: Month, staffId: number | null): Promise<Inputs[]> {
  const rows = await tx.rows<Omit<Inputs, 'staff'> & Staff>(
    `select ${STAFF_COLUMNS}, ${INPUT_COLUMNS}
     from fn_payroll_inputs($1, $2::date) i
     join staff s on s.id = i.staff_id
     cross join property_settings ps
     where $3::bigint is null or i.staff_id = $3
     order by s.name, s.id`,
    [member.propertyId, monthRange(month).start, staffId],
  );
  return rows.map(({ daysWorked, everyDayPresent, bonusEarned, stitches, advanceOutstanding, advanceGiven,
    paymentId, noLeaveBonusAmount, ...staff }) => ({
    staff, daysWorked, everyDayPresent, bonusEarned, stitches, advanceOutstanding, advanceGiven,
    paymentId, noLeaveBonusAmount,
  }));
}

/** The month as it works out from what is recorded now. */
function workOut(i: Inputs, otherDeductions = 0): SalaryBreakdown {
  // An unbroken month of full present days earns the no-leave amount on top.
  const noLeave = i.noLeaveBonusAmount > 0 && i.everyDayPresent ? i.noLeaveBonusAmount : 0;
  const b = calculateSalary({
    staff: i.staff,
    daysWorked: i.daysWorked,
    bonusEarned: i.bonusEarned,
    noLeaveBonus: noLeave,
    outstandingAdvance: i.advanceOutstanding,
    otherDeductions,
  });
  // The rate is stored to four places; show the same figure that would be.
  return { ...b, perDayRate: Math.round(b.perDayRate * 1e4) / 1e4 };
}

/** One row per active person. A paid month comes from its payslip. */
export async function preview(tx: Tx, member: Member, month: Month): Promise<PayrollRow[]> {
  const people = await inputs(tx, member, month, null);
  const ids = people.map((i) => i.paymentId).filter((id) => id !== null);
  const payments = new Map(
    (await tx.rows<SalaryPayment>(`select ${PAYMENT_COLUMNS} from salary_payments p where p.id = any($1::bigint[])`, [ids]))
      .map((p) => [p.staffId, p]),
  );
  return people.map((i) => {
    const payment = payments.get(i.staff.id) ?? null;
    const paid = payment?.status === 'paid';
    const breakdown = paid ? breakdownFromPayment(payment) : workOut(i);
    return {
      staff: i.staff,
      breakdown,
      outstandingAdvance: i.advanceOutstanding,
      advanceLeftAfter: advanceLeftAfter(i.advanceOutstanding, breakdown.advanceDeducted),
      upadThisMonth: i.advanceGiven,
      stitches: paid ? payment.stitchesInPeriod : i.stitches,
      payment,
    };
  });
}

export function list(tx: Tx, filter: { staffId?: number; year?: number }): Promise<SalaryPayment[]> {
  return tx.rows<SalaryPayment>(
    `select ${PAYMENT_COLUMNS} from salary_payments p
     where p.deleted_at is null
       and ($1::bigint is null or p.staff_id = $1)
       and ($2::int is null or extract(year from p.period_start) = $2)
     order by p.period_start desc, p.id desc`,
    [filter.staffId ?? null, filter.year ?? null],
  );
}

export async function get(tx: Tx, id: number): Promise<SalaryPayment> {
  const p = await tx.one<SalaryPayment>(
    `select ${PAYMENT_COLUMNS} from salary_payments p where p.id = $1 and p.deleted_at is null`, [id]);
  if (!p) throw notFound('No such payslip.');
  return p;
}

const livePayslip = (tx: Tx, staffId: number, periodStart: string) =>
  tx.one<SalaryPayment>(
    `select ${PAYMENT_COLUMNS} from salary_payments p
     where p.staff_id = $1 and p.period_start = $2 and p.deleted_at is null`,
    [staffId, periodStart],
  );

/**
 * Marks a month paid with the server's own snapshot of it. If the month is
 * already paid, that payslip comes back instead: a second tap must not pay
 * twice. Two taps at the same moment meet at salary_payments_live_period,
 * and the loser waits for and returns the winner's payslip.
 */
export async function markPaid(tx: Tx, member: Member, input: PayslipInput): Promise<SalaryPayment> {
  const otherDeductions = roundMoney(input.otherDeductions ?? 0);
  if (otherDeductions < 0) throw invalid({ otherDeductions: 'negative' }, 'Deductions cannot be negative.');
  const { start, end } = monthRange(input.month);
  const existing = await livePayslip(tx, input.staffId, start);
  if (existing) return existing;

  const [i] = await inputs(tx, member, input.month, input.staffId);
  if (!i) {
    const live = await tx.one(`select 1 from staff where id = $1 and deleted_at is null`, [input.staffId]);
    if (!live) throw notFound('No such person.');
    throw invalid({ staffId: 'inactive' }, 'Only an active person is paid.');
  }
  const b = workOut(i, otherDeductions);
  const row = await tx.one<{ id: number }>(
    `insert into salary_payments (
       property_id, staff_id, period_start, period_end, days_worked, per_day_rate, stitches_in_period,
       base_amount, bonus_amount, no_leave_bonus, salary_was_cut, advance_deducted, other_deductions,
       net_payable, paid_amount, status, paid_on, note, created_by_member_id, updated_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, 'paid', now(), $15, $16, $16)
     on conflict (staff_id, period_start) where deleted_at is null do nothing
     returning id`,
    [member.propertyId, input.staffId, start, end, b.daysWorked, b.perDayRate, i.stitches,
      b.baseAmount, b.bonusAmount, b.noLeaveBonus, b.salaryWasCut, b.advanceDeducted, b.otherDeductions,
      b.netPayable, input.note ?? null, member.memberId],
  );
  return row ? get(tx, row.id) : (await livePayslip(tx, input.staffId, start))!;
}

/**
 * Soft delete. The advance it recovered is owed again by itself: the balance
 * is derived. No batch, as for an advance (services/advances.ts remove).
 */
export async function remove(tx: Tx, member: Member, id: number): Promise<SalaryPayment> {
  const before = await get(tx, id);
  await tx.exec(
    `update salary_payments set deleted_at = now(), deleted_by_member_id = $2, updated_by_member_id = $2
     where id = $1 and deleted_at is null`,
    [id, member.memberId],
  );
  return before;
}
