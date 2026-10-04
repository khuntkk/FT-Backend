import type { MemberHandlers } from '../http/types.ts';
import * as production from '../services/production.ts';

export const productionHandlers: MemberHandlers<
  | 'GET /v1/production/day' | 'GET /v1/production/entry' | 'PUT /v1/production/entry'
  | 'DELETE /v1/production/entry/:id' | 'GET /v1/production/entries' | 'GET /v1/production/totals'
  | 'GET /v1/production/daily-totals' | 'POST /v1/production/scans'
> = {
  'GET /v1/production/day': (c) => production.day(c.tx, c.query.date, c.query.shiftId),
  'GET /v1/production/entry': (c) => production.find(c.tx, c.query.machineId, c.query.date, c.query.shiftId),
  'PUT /v1/production/entry': async (c) => {
    const saved = await production.save(c.tx, c.member, c.body);
    c.changed('production_entries', [saved.entry.id]);
    return saved;
  },
  'DELETE /v1/production/entry/:id': async (c) => {
    const before = await production.remove(c.tx, c.member, c.params.id);
    c.audit({ entityType: 'productionEntry', entityId: before.entry.id, before });
    c.changed('production_entries', [before.entry.id]);
  },
  'GET /v1/production/entries': (c) => production.page(c.tx, c.query),
  'GET /v1/production/totals': (c) => production.totals(c.tx, c.query.from, c.query.to, c.query.shiftId),
  'GET /v1/production/daily-totals': (c) => production.dailyTotals(c.tx, c.query.month, c.query.shiftId),
  'POST /v1/production/scans': (c) => production.recordScan(c.tx, c.member, c.body),
};
