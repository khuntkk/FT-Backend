// The database: two pools, one transaction per request.
//
// Every transaction takes a database role before it runs anything, so
// row-level security applies even if the login it connected as could bypass
// it. A request for a property also sets app.property_id; without it the
// API role sees no tenant rows at all — it fails closed (0004_security.sql).

import pg from 'pg';

// The apps decode JSON numbers and "YYYY-MM-DD" dates; pg's defaults would
// send bigint and numeric as strings and turn a DATE into a local-midnight
// instant, which moves the day in UTC. Exported so the tests' in-process
// Postgres converts exactly the same way.
const toNumber = (v: string) => Number(v);
const arrayOf = (oid: number) => {
  const parse = pg.types.getTypeParser(oid as never) as (v: string) => (string | null)[];
  return (v: string) => parse(v).map((x) => (x === null ? null : Number(x)));
};
export const PARSERS: Record<number, (v: string) => unknown> = {
  20: toNumber, // int8
  1700: toNumber, // numeric
  1016: arrayOf(1016), // int8[]
  1231: arrayOf(1231), // numeric[]
  1082: (v) => v, // date stays "YYYY-MM-DD"
  1184: (v) => new Date(v).toISOString(), // timestamptz → "…Z"
};
for (const [oid, parse] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid) as never, parse);

export type Row = Record<string, any>;

/** What a service gets: one open transaction. */
export interface Tx {
  rows<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Runs a statement; returns how many rows it touched. */
  exec(sql: string, params?: unknown[]): Promise<number>;
  /** Runs after a successful commit (change notices). */
  afterCommit(fn: () => void): void;
}

export interface Db {
  /** As the apps' API role, for one property — or for none, before one is chosen. */
  api<T>(propertyId: number | null, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** As the web admin panel's role, which sees every property. */
  platform<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('connect', (client) => {
    client.query(`set time zone 'UTC'`).catch(() => {});
  });
  return pool;
}

/** One connection, held for a transaction. pg's PoolClient is one. */
export interface Connection {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}

async function inTransaction<T>(
  acquire: () => Promise<Connection>,
  role: 'stitchflow_api' | 'stitchflow_platform',
  propertyId: number | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await acquire();
  const onCommit: (() => void)[] = [];
  const tx: Tx = {
    rows: async (sql, params) => (await client.query(sql, params)).rows,
    one: async (sql, params) => (await client.query(sql, params)).rows[0],
    exec: async (sql, params) => (await client.query(sql, params)).rowCount ?? 0,
    afterCommit: (f) => void onCommit.push(f),
  };
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    if (propertyId !== null) {
      await client.query(`select set_config('app.property_id', $1, true)`, [String(propertyId)]);
    }
    const result = await fn(tx);
    await client.query('commit');
    for (const f of onCommit) f();
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function createDb(apiPool: pg.Pool, platformPool: pg.Pool = apiPool): Db {
  return dbFrom(() => apiPool.connect(), () => platformPool.connect(), async () => {
    await apiPool.end();
    if (platformPool !== apiPool) await platformPool.end();
  });
}

/** A Db over any source of connections (the tests use an in-process Postgres). */
export function dbFrom(
  acquireApi: () => Promise<Connection>,
  acquirePlatform: () => Promise<Connection>,
  close: () => Promise<void>,
): Db {
  return {
    api: (propertyId, fn) => inTransaction(acquireApi, 'stitchflow_api', propertyId, fn),
    platform: (fn) => inTransaction(acquirePlatform, 'stitchflow_platform', null, fn),
    close,
  };
}
