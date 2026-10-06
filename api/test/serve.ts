// A throwaway StitchFlow API for the apps' own tests: the real app on an
// in-process Postgres (PGlite), listening on a port. Nothing is kept.
//
//   npm run serve:test -w api            # http://127.0.0.1:3900
//
// One extra route, here only: POST /__test/property makes a fresh unit with
// one login per role (password PASSWORD), so each test starts clean.

import { hashPassword } from '../src/auth/passwords.ts';
import { PASSWORD, seedProperty, startHarness } from './helpers.ts';

const port = Number(process.env.PORT ?? 3900);
const h = await startHarness({ corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean) });
h.app.post('/__test/property', async (req) => {
  const { machineLimit } = (req.body ?? {}) as { machineLimit?: number };
  const p = await seedProperty(h, { machineLimit: machineLimit ?? 50 });
  return {
    propertyId: p.propertyId,
    code: p.code,
    password: PASSWORD,
    usernames: Object.fromEntries(Object.entries(p.members).map(([role, m]) => [role, m.username])),
  };
});
// Console staff, for trying the web admin panel: { email, password }.
h.app.post('/__test/platform-staff', async (req) => {
  const { role = 'admin', mustChangePassword = false } = (req.body ?? {}) as { role?: string; mustChangePassword?: boolean };
  const email = `${role}-${Date.now()}@stitchflow.test`;
  const [{ id }] = await h.sql(
    `insert into users (display_name, email, password_hash, must_change_password)
     values ($1, $2, $3, $4) returning id`,
    [`Test ${role}`, email, await hashPassword(PASSWORD), mustChangePassword]);
  await h.sql(`insert into platform_staff (user_id, role) values ($1, $2)`, [id, role]);
  return { email, password: PASSWORD, userId: id };
});

const address = await h.app.listen({ port, host: '127.0.0.1' });
console.log(`test API on ${address}`);
const stop = async () => {
  await h.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
