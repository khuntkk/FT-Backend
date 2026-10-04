// Runs the daily jobs once, for a scheduler outside the API process:
//   RUN_JOBS=false in the API, and `npm run purge` daily from cron.

import { createDb, createPool } from '../db/db.ts';
import { runDailyJobs } from './daily.ts';

const url = process.env.PLATFORM_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('Set PLATFORM_DATABASE_URL or DATABASE_URL.');
const db = createDb(createPool(url, 1));
try {
  console.log(await runDailyJobs(db));
} finally {
  await db.close();
}
