import type { MemberHandlers } from '../http/types.ts';
import * as settings from '../services/settings.ts';

export const settingsHandlers: MemberHandlers<
  'GET /v1/settings' | 'PATCH /v1/settings' | 'POST /v1/settings/reset-data'
> = {
  'GET /v1/settings': (c) => settings.get(c.tx, c.member.propertyId),
  'PATCH /v1/settings': async (c) => {
    const s = await settings.update(c.tx, c.member.propertyId, c.body);
    c.changed('property_settings', [c.member.propertyId]);
    return s;
  },
  'POST /v1/settings/reset-data': async (c) => {
    const removed = await settings.resetData(c.tx, c.member, c.body.confirmPropertyCode);
    c.audit({ entityType: 'property', entityId: c.member.propertyId, after: { removed } });
    for (const table of settings.RESET_TABLES) c.changed(table, []);
  },
};
