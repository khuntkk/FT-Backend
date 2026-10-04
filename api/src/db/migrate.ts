// Applies db/migrations (once each, in order, recorded in schema_migrations)
// and then every file in db/views (create or replace, every time).
//
//   npm run migrate        uses MIGRATION_DATABASE_URL, else DATABASE_URL
//
// Run it as the schema owner: row-level security does not restrict the
// owner, and 0004 grants the API's roles what they need.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dbDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db');
const sqlFiles = (sub: string) =>
  readdirSync(join(dbDir, sub)).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dbDir, sub, f), 'utf8') }));

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Returns the migrations it applied. */
export async function migrate(db: Queryable, log: (s: string) => void = () => {}): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (
    filename text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query(`select filename from schema_migrations`)).rows.map((r) => r.filename));
  const applied: string[] = [];
  for (const m of sqlFiles('migrations')) {
    if (done.has(m.name)) continue;
    log(`migrating ${m.name}`);
    await db.query('begin');
    try {
      await db.query(m.sql);
      await db.query(`insert into schema_migrations (filename) values ($1)`, [m.name]);
      await db.query('commit');
    } catch (e) {
      await db.query('rollback');
      throw new Error(`${m.name}: ${(e as Error).message}`);
    }
    applied.push(m.name);
  }
  await db.query('begin');
  try {
    for (const v of sqlFiles('views')) await db.query(v.sql);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
  log('views and functions applied');
  return applied;
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL (the schema owner) or DATABASE_URL.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await migrate(client, console.log);
    console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema up to date');
  } finally {
    await client.end();
  }
}
