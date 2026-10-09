// A throwaway StitchFlow for tests: PGlite (real Postgres in WebAssembly),
// in process, with every migration and view applied. No Postgres install.
//
// The API runs on it through the same transaction code as in production
// (dbFrom in db.ts) and with the same type conversions (PARSERS). PGlite is
// one session, so connections are handed out one at a time.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import type { FastifyInstance } from 'fastify';
import type { UserRole } from '@stitchflow/contract';
import { buildApp } from '../src/app.ts';
import { dbFrom, PARSERS, type Connection } from '../src/db/db.ts';
import { EventBus } from '../src/http/events.ts';
import type { Storage } from '../src/storage/storage.ts';
import { migrate } from '../src/db/migrate.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { clearSignInLimits } from '../src/services/rateLimit.ts';

export const PASSWORD = 'correct-horse-9';

export interface Harness {
  app: FastifyInstance;
  /** The app's change-notice bus (GET /v1/events). */
  events: EventBus;
  /** Superuser SQL, for arranging and inspecting; bypasses row-level security. */
  sql<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Hands out PGlite's one session to one holder at a time. */
function sessionLock(pglite: PGlite) {
  let tail = Promise.resolve();
  const query = async (sql: string, params?: unknown[]) => {
    // Without parameters, exec: a migration is several statements in one string.
    if (!params?.length) {
      const results = await pglite.exec(sql);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []) as any[], rowCount: last?.affectedRows ?? 0 };
    }
    const r = await pglite.query(sql, params);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  };
  return async (): Promise<Connection> => {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((r) => (release = r));
    await previous;
    return { query, release };
  };
}

export async function startHarness(opts: { storage?: Storage; corsOrigins?: string[]; unauthLimit?: number; requirePlatformTotp?: boolean } = {}): Promise<Harness> {
  const pglite = await PGlite.create({ extensions: { btree_gist, citext }, parsers: PARSERS });
  await pglite.exec(`set time zone 'UTC'`);
  const acquire = sessionLock(pglite);
  const migrator = await acquire();
  try {
    await migrate(migrator);
  } finally {
    migrator.release();
  }
  const filesDir = await mkdtemp(join(tmpdir(), 'sf-files-'));
  const db = dbFrom(acquire, acquire, async () => {});
  const events = new EventBus();
  const app = await buildApp({
    db,
    events,
    storage: opts.storage,
    // Tests sign in far more than 30 times a minute from one address.
    unauthLimit: opts.unauthLimit ?? 100_000,
    config: {
      port: 0, host: '127.0.0.1', databaseUrl: 'pglite', platformDatabaseUrl: 'pglite',
      jwtSecret: 'test-secret-test-secret-test-secret!', filesDir, supabase: null, runJobs: false, corsOrigins: opts.corsOrigins ?? [],
      logLevel: 'silent', trustProxy: false, requirePlatformTotp: opts.requirePlatformTotp ?? false,
    },
  });
  clearSignInLimits();
  return {
    app,
    events,
    sql: async (text, params) => {
      const c = await acquire();
      try {
        return (await c.query(text, params)).rows;
      } finally {
        c.release();
      }
    },
    close: async () => {
      await app.close();
      await pglite.close();
      await rm(filesDir, { recursive: true, force: true });
    },
  };
}

export interface Response<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

/** A client for the app, signed in or not. */
export class Client {
  readonly app: FastifyInstance;
  token: string | null;
  refreshToken: string | null = null;

  constructor(app: FastifyInstance, token: string | null = null) {
    this.app = app;
    this.token = token;
  }

  async call<T = any>(
    method: string,
    url: string,
    opts: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<Response<T>> {
    const res = await this.app.inject({
      method: method as any,
      url,
      query: opts.query,
      payload: opts.body as any,
      headers: { ...(this.token && { authorization: `Bearer ${this.token}` }), ...opts.headers },
    });
    let body: any = res.body;
    if (res.headers['content-type']?.toString().includes('application/json')) body = res.json();
    return { status: res.statusCode, body, headers: res.headers };
  }

  get = <T = any>(url: string, query?: Record<string, string>) => this.call<T>('GET', url, { query });
  post = <T = any>(url: string, body?: unknown, headers?: Record<string, string>) =>
    this.call<T>('POST', url, { body: body ?? {}, headers });
  put = <T = any>(url: string, body?: unknown) => this.call<T>('PUT', url, { body: body ?? {} });
  patch = <T = any>(url: string, body?: unknown) => this.call<T>('PATCH', url, { body: body ?? {} });
  del = <T = any>(url: string, query?: Record<string, string>) => this.call<T>('DELETE', url, { query });
}

export interface SeededProperty {
  propertyId: number;
  code: string;
  /** memberId and username per role; the owner is the superAdmin. */
  members: Record<UserRole | 'superAdmin2', { memberId: number; userId: number; username: string }>;
}

let seq = 0;

/**
 * A property with its settings, the default day/night shifts from
 * 2026-01-01, and one signed-in-able member of each role (password PASSWORD,
 * no password change pending). The owner is members.superAdmin.
 */
export async function seedProperty(
  h: Harness,
  opts: { machineLimit?: number; timezone?: string } = {},
): Promise<SeededProperty> {
  const n = ++seq;
  const code = `unit-${n}`;
  const [{ id: propertyId }] = await h.sql(
    `insert into properties (code, name, timezone, machine_limit) values ($1, $2, $3, $4) returning id`,
    [code, `Unit ${n}`, opts.timezone ?? 'Asia/Kolkata', opts.machineLimit ?? 50],
  );
  await h.sql(`insert into property_settings (property_id, business_name) values ($1, $2)`, [propertyId, `Unit ${n}`]);
  await h.sql(
    `insert into shifts (property_id, name, start_minute, duration_minutes, sort_order, effective_from)
     values ($1, 'Day', 480, 720, 0, '2026-01-01'), ($1, 'Night', 1200, 720, 1, '2026-01-01')`,
    [propertyId],
  );
  const hash = await passwordHash();
  const members = {} as SeededProperty['members'];
  const roles: [keyof SeededProperty['members'], UserRole, boolean][] = [
    ['superAdmin', 'superAdmin', true],
    ['superAdmin2', 'superAdmin', false],
    ['admin', 'admin', false],
    ['viewAdmin', 'viewAdmin', false],
    ['supervisor', 'supervisor', false],
    ['worker', 'worker', false],
  ];
  for (const [key, role, isOwner] of roles) {
    const username = `${key.toLowerCase()}-${n}`;
    const [{ id: userId }] = await h.sql(
      `insert into users (display_name, username, password_hash, must_change_password)
       values ($1, $2, $3, false) returning id`,
      [`${key} ${n}`, username, hash],
    );
    const [{ id: memberId }] = await h.sql(
      `insert into property_members (property_id, user_id, role, is_owner) values ($1, $2, $3, $4) returning id`,
      [propertyId, userId, role, isOwner],
    );
    members[key] = { memberId, userId, username };
  }
  return { propertyId, code, members };
}

let cachedHash: Promise<string> | null = null;
const passwordHash = () => (cachedHash ??= hashPassword(PASSWORD));

/** Signs in with a username and returns a client acting in the user's only property. */
export async function signIn(h: Harness, username: string, password = PASSWORD): Promise<Client> {
  const c = new Client(h.app);
  const res = await c.post('/v1/auth/login', {
    identifier: username, password, client: 'managerApp', keepSignedIn: false,
  });
  if (res.status !== 200) throw new Error(`sign-in failed for ${username}: ${JSON.stringify(res.body)}`);
  c.token = res.body.accessToken;
  c.refreshToken = res.body.refreshToken;
  return c;
}

/** One signed-in client per role of a seeded property. */
export async function signInAll(h: Harness, p: SeededProperty) {
  const out = {} as Record<keyof SeededProperty['members'], Client>;
  for (const [key, m] of Object.entries(p.members)) {
    out[key as keyof SeededProperty['members']] = await signIn(h, m.username);
  }
  return out;
}

