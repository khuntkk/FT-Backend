import type { MemberHandlers } from '../http/types.ts';
import * as machines from '../services/machines.ts';

export const machineHandlers: MemberHandlers<
  | 'GET /v1/machines' | 'GET /v1/machines/allowance' | 'POST /v1/machines' | 'POST /v1/machines/bulk'
  | 'PATCH /v1/machines/:id' | 'DELETE /v1/machines/:id'
> = {
  'GET /v1/machines': (c) => machines.list(c.tx, c.query.activeOnly),
  'GET /v1/machines/allowance': (c) => machines.allowance(c.tx, c.member.propertyId),
  'POST /v1/machines': async (c) => {
    const m = await machines.create(c.tx, c.member, c.body);
    c.changed('machines', [m.id]);
    return m;
  },
  'POST /v1/machines/bulk': async (c) => {
    const result = await machines.createUpTo(c.tx, c.member, c.body.upTo);
    c.changed('machines', []);
    return result;
  },
  'PATCH /v1/machines/:id': async (c) => {
    const m = await machines.update(c.tx, c.member, c.params.id, c.body);
    c.changed('machines', [m.id]);
    return m;
  },
  'DELETE /v1/machines/:id': async (c) => {
    const before = await machines.remove(c.tx, c.member, c.params.id);
    c.audit({ entityType: 'machine', entityId: before.id, before });
    c.changed('machines', [before.id]);
  },
};
