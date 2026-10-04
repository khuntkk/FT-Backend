import type { PlatformHandlers } from '../http/types.ts';
import * as platform from '../services/platform.ts';

// The router writes an audit row for every console call that changes
// something; these fill it in. A temporary password never goes into it.
export const platformHandlers: PlatformHandlers<
  | 'GET /v1/platform/properties' | 'POST /v1/platform/properties' | 'GET /v1/platform/properties/:id'
  | 'PATCH /v1/platform/properties/:id' | 'POST /v1/platform/properties/:id/transfer-ownership'
  | 'GET /v1/platform/users' | 'GET /v1/platform/users/:id' | 'POST /v1/platform/users/:id/reset-password'
  | 'POST /v1/platform/users/:id/disable' | 'POST /v1/platform/users/:id/enable'
  | 'DELETE /v1/platform/users/:id/sessions' | 'GET /v1/platform/audit'
  | 'GET /v1/platform/staff' | 'POST /v1/platform/staff' | 'DELETE /v1/platform/staff/:id'
> = {
  'GET /v1/platform/properties': (c) => platform.listProperties(c.tx, c.query),
  'POST /v1/platform/properties': async (c) => {
    const created = await platform.createProperty(c.tx, c.body);
    c.audit({
      entityType: 'property', entityId: created.property.id, propertyId: created.property.id,
      after: { property: created.property, ownerMemberId: created.owner.id, ownerUserId: created.owner.userId },
    });
    return created;
  },
  'GET /v1/platform/properties/:id': (c) => platform.getPropertyDetail(c.tx, c.params.id),
  'PATCH /v1/platform/properties/:id': async (c) => {
    const { before, after } = await platform.updateProperty(c.tx, c.params.id, c.body);
    c.audit({ entityType: 'property', entityId: after.id, before, after });
    return after;
  },
  'POST /v1/platform/properties/:id/transfer-ownership': async (c) => {
    const { from, to } = await platform.transferOwnership(c.tx, c.params.id, c.body.toMemberId);
    c.audit({ entityType: 'property', entityId: c.params.id, before: { ownerMemberId: from }, after: { ownerMemberId: to } });
  },

  'GET /v1/platform/users': (c) => platform.searchUsers(c.tx, c.query.query),
  'GET /v1/platform/users/:id': (c) => platform.getPlatformUser(c.tx, c.params.id),
  'POST /v1/platform/users/:id/reset-password': async (c) => {
    const temporaryPassword = await platform.resetPassword(c.tx, c.staff.role, c.params.id);
    c.audit({ entityType: 'user', entityId: c.params.id, after: { mustChangePassword: true } });
    return { temporaryPassword };
  },
  'POST /v1/platform/users/:id/disable': async (c) => {
    const { before, after } = await platform.setUserStatus(c.tx, c.staff.userId, c.params.id, 'disabled');
    c.audit({ entityType: 'user', entityId: after.id, before, after });
    return after;
  },
  'POST /v1/platform/users/:id/enable': async (c) => {
    const { before, after } = await platform.setUserStatus(c.tx, c.staff.userId, c.params.id, 'active');
    c.audit({ entityType: 'user', entityId: after.id, before, after });
    return after;
  },
  'DELETE /v1/platform/users/:id/sessions': async (c) => {
    const revoked = await platform.signOutEverywhere(c.tx, c.params.id);
    c.audit({ entityType: 'user', entityId: c.params.id, after: { sessionsRevoked: revoked } });
  },

  'GET /v1/platform/audit': (c) => platform.listAudit(c.tx, c.query),

  'GET /v1/platform/staff': (c) => platform.listStaff(c.tx),
  'POST /v1/platform/staff': async (c) => {
    const created = await platform.addStaff(c.tx, c.staff.userId, c.body);
    c.audit({ entityType: 'platformStaff', entityId: created.staff.userId, after: created.staff });
    return created;
  },
  'DELETE /v1/platform/staff/:id': async (c) => {
    const before = await platform.removeStaff(c.tx, c.staff.userId, c.params.id);
    c.audit({ entityType: 'platformStaff', entityId: before.userId, before });
  },
};
