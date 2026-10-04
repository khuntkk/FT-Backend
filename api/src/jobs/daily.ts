// The daily jobs (HANDOVER §13): purge the recycle bin past its seven days,
// and drop sessions and idempotency keys nobody can use any more.

import type { Db } from '../db/db.ts';
import { purgeExpired } from '../services/recycleBin.ts';

export async function runDailyJobs(db: Db) {
  return db.platform(async (tx) => {
    // As the platform role, which sees every property: one purge for all.
    const purged = await purgeExpired(tx);
    const sessions = await tx.exec(
      `delete from auth_sessions where expires_at < now() - interval '1 day'
          or revoked_at < now() - interval '30 days'`);
    const keys = await tx.exec(`delete from idempotency_keys where created_at < now() - interval '24 hours'`);
    return { purged, sessions, idempotencyKeys: keys };
  });
}
