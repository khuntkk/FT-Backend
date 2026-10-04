// Makes the first console admin:
//
//   npm run create-platform-admin -- --email a@b.c --name "Name"
//
// Console staff are added from the console by an admin, so the very first
// admin cannot be: this script is how one comes to exist. It prints the
// temporary password once; it must be changed at the first sign-in.

import { parseArgs } from 'node:util';
import { createDb, createPool } from '../db/db.ts';
import { ApiError } from '../http/errors.ts';
import { addStaff } from '../services/platform.ts';

const usage = 'Usage: npm run create-platform-admin -- --email a@b.c --name "Name"';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error(usage);
  process.exit(2);
}

const url = process.env.PLATFORM_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('Set PLATFORM_DATABASE_URL or DATABASE_URL.');
const db = createDb(createPool(url, 1));
try {
  const created = await db.platform(async (tx) => {
    const result = await addStaff(tx, null, { displayName: values.name!, email: values.email!, role: 'admin' });
    // The console audits what its staff do; this is the one console change
    // made outside it, so it is written here.
    await tx.exec(
      `insert into audit_log (action, entity_type, entity_id, after)
       values ('platform.create-platform-admin', 'platformStaff', $1, $2)`,
      [String(result.staff.userId), JSON.stringify(result.staff)],
    );
    return result;
  });
  console.log(`Console admin ${created.staff.displayName} <${created.staff.email}> (user ${created.staff.userId}).`);
  console.log(created.temporaryPassword
    ? `Temporary password, shown once: ${created.temporaryPassword}`
    : 'They already have a password and sign in with it.');
} catch (e) {
  if (!(e instanceof ApiError)) throw e;
  console.error(`${e.message} ${JSON.stringify(e.details ?? {})}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
