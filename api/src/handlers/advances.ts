import type { MemberHandlers } from '../http/types.ts';
import * as advances from '../services/advances.ts';

export const advancesHandlers: MemberHandlers<
  | 'GET /v1/advances' | 'GET /v1/staff/:id/advance-balance' | 'POST /v1/advances' | 'DELETE /v1/advances/:id'
> = {
  'GET /v1/advances': (c) => advances.list(c.tx, c.query),
  'GET /v1/staff/:id/advance-balance': (c) => advances.balance(c.tx, c.member, c.params.id, c.query.month),
  'POST /v1/advances': async (c) => {
    const a = await advances.create(c.tx, c.member, c.body);
    c.changed('advances', [a.id]);
    return a;
  },
  'DELETE /v1/advances/:id': async (c) => {
    const before = await advances.remove(c.tx, c.member, c.params.id);
    c.audit({ entityType: 'advance', entityId: before.id, before });
    c.changed('advances', [before.id]);
  },
};
