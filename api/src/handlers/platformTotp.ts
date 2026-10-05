import type { PlatformHandlers } from '../http/types.ts';
import * as totp from '../services/platformTotp.ts';

// The router audits each of these (console changes); the secret never goes
// into the audit row, because nothing here passes it to c.audit.
export const platformTotpHandlers: PlatformHandlers<
  | 'POST /v1/platform/auth/totp/setup' | 'POST /v1/platform/auth/totp/enable'
  | 'POST /v1/platform/auth/totp/disable' | 'DELETE /v1/platform/staff/:id/totp'
> = {
  'POST /v1/platform/auth/totp/setup': async (c) => {
    c.audit({ entityType: 'platformStaff', entityId: c.staff.userId });
    return totp.setup(c.tx, c.staff.userId);
  },
  'POST /v1/platform/auth/totp/enable': async (c) => {
    await totp.enable(c.tx, c.staff.userId, c.body.code);
    c.audit({ entityType: 'platformStaff', entityId: c.staff.userId, after: { totpEnabled: true } });
  },
  'POST /v1/platform/auth/totp/disable': async (c) => {
    await totp.disable(c.tx, c.staff.userId, c.body.code);
    c.audit({ entityType: 'platformStaff', entityId: c.staff.userId, after: { totpEnabled: false } });
  },
  'DELETE /v1/platform/staff/:id/totp': async (c) => {
    await totp.resetFor(c.tx, c.staff.userId, c.params.id);
    c.audit({ entityType: 'platformStaff', entityId: c.params.id, after: { totpEnabled: false } });
  },
};
