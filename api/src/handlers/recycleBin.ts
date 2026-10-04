import type { MemberHandlers } from '../http/types.ts';
import * as bin from '../services/recycleBin.ts';

export const recycleBinHandlers: MemberHandlers<
  | 'GET /v1/recycle-bin' | 'POST /v1/recycle-bin/:kind/:id/restore'
  | 'DELETE /v1/recycle-bin/:kind/:id' | 'DELETE /v1/recycle-bin'
> = {
  'GET /v1/recycle-bin': (c) => bin.list(c.tx, c.member),
  'POST /v1/recycle-bin/:kind/:id/restore': async (c) => {
    const also = bin.RESTORE_ALSO_NEEDS[c.params.kind];
    if (also) await c.assertCan(also);
    await bin.restore(c.tx, c.member, c.params.kind, c.params.id);
    c.changed(bin.TABLE_OF[c.params.kind], [c.params.id]);
  },
  'DELETE /v1/recycle-bin/:kind/:id': async (c) => {
    const before = await bin.deleteForever(c.tx, c.params.kind, c.params.id);
    c.audit({ entityType: c.params.kind, entityId: before.id, before });
    c.changed(bin.TABLE_OF[c.params.kind], [before.id]);
  },
  'DELETE /v1/recycle-bin': async (c) => {
    const before = await bin.empty(c.tx, c.member);
    c.audit({ entityType: 'recycle_bin', entityId: null, before });
    for (const table of new Set(before.map((i) => bin.TABLE_OF[i.kind]))) c.changed(table, []);
  },
};
