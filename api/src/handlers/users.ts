import type { MemberHandlers } from '../http/types.ts';
import * as users from '../services/users.ts';

// Changes to who can do what are audited even where the route is not
// destructive (force), with the member before and after.
export const usersHandlers: MemberHandlers<
  | 'GET /v1/users' | 'POST /v1/users' | 'PATCH /v1/users/:memberId/access'
  | 'POST /v1/users/:memberId/reset-password' | 'POST /v1/users/:memberId/disable'
  | 'POST /v1/users/:memberId/enable' | 'DELETE /v1/users/:memberId'
  | 'POST /v1/users/:memberId/super-admin' | 'DELETE /v1/users/:memberId/super-admin'
  | 'POST /v1/users/transfer-ownership'
> = {
  'GET /v1/users': (c) => users.list(c.tx),
  'POST /v1/users': async (c) => {
    const created = await users.create(c.tx, c.member, c.body);
    c.audit({ entityType: 'member', entityId: created.member.id, after: created.member, force: true });
    c.changed('property_members', [created.member.id]);
    return created;
  },
  'PATCH /v1/users/:memberId/access': async (c) => {
    const [before, after] = await users.updateAccess(c.tx, c.member, c.params.memberId, c.body.modules);
    c.audit({ entityType: 'member', entityId: after.id, before, after, force: true });
    c.changed('property_members', [after.id]);
    return after;
  },
  'POST /v1/users/:memberId/reset-password': async (c) => {
    const temporaryPassword = await users.resetPassword(c.tx, c.member, c.params.memberId);
    c.audit({ entityType: 'member', entityId: c.params.memberId, force: true });
    return { temporaryPassword };
  },
  'POST /v1/users/:memberId/disable': async (c) => {
    const [before, after] = await users.setStatus(c.tx, c.member, c.params.memberId, 'disabled');
    c.audit({ entityType: 'member', entityId: after.id, before, after, force: true });
    c.changed('property_members', [after.id]);
    return after;
  },
  'POST /v1/users/:memberId/enable': async (c) => {
    const [before, after] = await users.setStatus(c.tx, c.member, c.params.memberId, 'active');
    c.audit({ entityType: 'member', entityId: after.id, before, after, force: true });
    c.changed('property_members', [after.id]);
    return after;
  },
  'DELETE /v1/users/:memberId': async (c) => {
    const before = await users.remove(c.tx, c.member, c.params.memberId);
    c.audit({ entityType: 'member', entityId: before.id, before });
    c.changed('property_members', [before.id]);
  },
  'POST /v1/users/:memberId/super-admin': async (c) => {
    const [before, after] = await users.setSuperAdmin(c.tx, c.params.memberId, true);
    c.audit({ entityType: 'member', entityId: after.id, before, after });
    c.changed('property_members', [after.id]);
    return after;
  },
  'DELETE /v1/users/:memberId/super-admin': async (c) => {
    const [before, after] = await users.setSuperAdmin(c.tx, c.params.memberId, false);
    c.audit({ entityType: 'member', entityId: after.id, before, after });
    c.changed('property_members', [after.id]);
    return after;
  },
  'POST /v1/users/transfer-ownership': async (c) => {
    const to = await users.transferOwnership(c.tx, c.member, c.body.toMemberId);
    c.audit({
      entityType: 'property', entityId: c.member.propertyId,
      before: { ownerMemberId: c.member.memberId }, after: { ownerMemberId: to.id },
    });
    c.changed('property_members', [c.member.memberId, to.id]);
  },
};
