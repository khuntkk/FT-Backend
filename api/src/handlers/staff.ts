import type { MemberHandlers } from '../http/types.ts';
import * as staff from '../services/staff.ts';

export const staffHandlers: MemberHandlers<
  | 'GET /v1/staff' | 'GET /v1/staff/next-code' | 'GET /v1/staff/:id' | 'POST /v1/staff'
  | 'PATCH /v1/staff/:id' | 'DELETE /v1/staff/:id' | 'GET /v1/operators'
> = {
  'GET /v1/staff': (c) => staff.list(c.tx, c.query.activeOnly, c.query.category ?? null),
  'GET /v1/staff/next-code': (c) => staff.nextCode(c.tx),
  'GET /v1/staff/:id': (c) => staff.get(c.tx, c.params.id),
  'POST /v1/staff': async (c) => {
    const s = await staff.create(c.tx, c.member, c.body);
    c.changed('staff', [s.id]);
    return s;
  },
  'PATCH /v1/staff/:id': async (c) => {
    const s = await staff.update(c.tx, c.member, c.params.id, c.body);
    c.changed('staff', [s.id]);
    return s;
  },
  'DELETE /v1/staff/:id': async (c) => {
    const before = await staff.remove(c.tx, c.member, c.params.id);
    c.audit({ entityType: 'staff', entityId: before.id, before });
    c.changed('staff', [before.id]);
    c.changed('advances', []);
    c.changed('salary_payments', []);
  },
  'GET /v1/operators': (c) => staff.operators(c.tx, c.query.activeOnly),
};
