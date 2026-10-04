// Runs the API: one process serving the apps and the web admin panel, with
// the daily jobs on a timer (set RUN_JOBS=false to run them from a scheduler
// instead, with `npm run purge`).

import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, createPool } from './db/db.ts';
import { runDailyJobs } from './jobs/daily.ts';

const config = loadConfig();
const apiPool = createPool(config.databaseUrl);
const platformPool = config.platformDatabaseUrl === config.databaseUrl
  ? apiPool
  : createPool(config.platformDatabaseUrl, 4);
const db = createDb(apiPool, platformPool);
const app = await buildApp({ config, db });

let timer: NodeJS.Timeout | undefined;
if (config.runJobs) {
  const run = () => runDailyJobs(db).then(
    (r) => app.log.info(r, 'daily jobs done'),
    (err) => app.log.error({ err }, 'daily jobs failed'),
  );
  timer = setInterval(run, 24 * 60 * 60 * 1000);
  setTimeout(run, 60 * 1000).unref();
}

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
