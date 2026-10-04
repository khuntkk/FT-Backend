import type { MemberHandlers } from '../http/types.ts';
import * as payroll from '../services/payroll.ts';

export const payrollHandlers: MemberHandlers<
  | 'GET /v1/payroll/preview' | 'GET /v1/payroll/payslips' | 'POST /v1/payroll/payslips'
  | 'DELETE /v1/payroll/payslips/:id'
> = {
  'GET /v1/payroll/preview': (c) => payroll.preview(c.tx, c.member, c.query.month),
  'GET /v1/payroll/payslips': (c) => payroll.list(c.tx, c.query),
  'POST /v1/payroll/payslips': async (c) => {
    const p = await payroll.markPaid(c.tx, c.member, c.body);
    c.changed('salary_payments', [p.id]);
    return p;
  },
  'DELETE /v1/payroll/payslips/:id': async (c) => {
    const before = await payroll.remove(c.tx, c.member, c.params.id);
    c.audit({ entityType: 'salaryPayment', entityId: before.id, before });
    c.changed('salary_payments', [before.id]);
  },
};
