import type { MemberHandlers } from '../http/types.ts';
import * as bonusRules from '../services/bonusRules.ts';

export const bonusRulesHandlers: MemberHandlers<
  | 'GET /v1/bonus-rules' | 'GET /v1/bonus-rules/:id' | 'POST /v1/bonus-rules' | 'PUT /v1/bonus-rules/:id'
  | 'PATCH /v1/bonus-rules/:id' | 'DELETE /v1/bonus-rules/:id'
> = {
  'GET /v1/bonus-rules': (c) => bonusRules.list(c.tx),
  'GET /v1/bonus-rules/:id': (c) => bonusRules.get(c.tx, c.params.id),
  'POST /v1/bonus-rules': async (c) => {
    const r = await bonusRules.create(c.tx, c.member, c.body);
    c.changed('bonus_rules', [r.id]);
    return r;
  },
  'PUT /v1/bonus-rules/:id': async (c) => {
    const r = await bonusRules.replace(c.tx, c.member, c.params.id, c.body);
    c.changed('bonus_rules', [r.id]);
    return r;
  },
  'PATCH /v1/bonus-rules/:id': async (c) => {
    const r = await bonusRules.setActive(c.tx, c.member, c.params.id, c.body.isActive);
    c.changed('bonus_rules', [r.id]);
    return r;
  },
  'DELETE /v1/bonus-rules/:id': async (c) => {
    const before = await bonusRules.remove(c.tx, c.member, c.params.id);
    c.audit({ entityType: 'bonusRule', entityId: before.id, before });
    c.changed('bonus_rules', [before.id]);
  },
};
