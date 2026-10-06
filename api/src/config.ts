import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Configuration, from the environment only. Secrets come from the host's
// secret store in staging and production, from ../.env in development.

export interface Config {
  port: number;
  host: string;
  /** The apps' API connects as a login granted stitchflow_api. */
  databaseUrl: string;
  /** The web admin panel's API connects as a login granted stitchflow_platform. */
  platformDatabaseUrl: string;
  /** HS256 key for access tokens. At least 32 characters. */
  jwtSecret: string;
  /** Local disk for photos, used when no Supabase project is configured. */
  filesDir: string;
  /** Supabase Storage for photos: set SUPABASE_URL and SUPABASE_SECRET_KEY. */
  supabase: { url: string; secretKey: string; bucket: string } | null;
  /** Run the daily purge and session expiry inside this process. */
  runJobs: boolean;
  logLevel: string;
  /** Behind a load balancer: trust X-Forwarded-* for the client's IP and scheme. */
  trustProxy: boolean;
  /** Browser origins allowed to call the API (the web admin panel's), e.g. https://admin.example.com. */
  corsOrigins: string[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See .env.example.`);
  return v;
}

export function loadConfig(): Config {
  const databaseUrl = required('DATABASE_URL');
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl,
    platformDatabaseUrl: process.env.PLATFORM_DATABASE_URL || databaseUrl,
    jwtSecret,
    filesDir: process.env.FILES_DIR ?? 'var/files',
    supabase: supabaseFromEnv(),
    runJobs: process.env.RUN_JOBS !== 'false',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    trustProxy: process.env.TRUST_PROXY === 'true',
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function supabaseFromEnv(): Config['supabase'] {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error('SUPABASE_URL is set but SUPABASE_SECRET_KEY is not.');
  return { url, secretKey, bucket: process.env.SUPABASE_BUCKET || 'stitchflow-photos' };
}

/**
 * Connection options for a database URL. TLS unless the database is on this
 * machine: DATABASE_SSL=verify checks the server's certificate against
 * DATABASE_CA_FILE (Supabase: Database settings → SSL → download), `require`
 * encrypts without checking it, `off` is plain. An sslmode in the URL is
 * dropped: pg would let it override these.
 */
export function pgOptions(url: string): { connectionString: string; ssl?: object | false } {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  const mode = process.env.DATABASE_SSL || (local ? 'off' : 'require');
  if (mode === 'off') return { connectionString: u.toString(), ssl: false };
  if (mode === 'require') return { connectionString: u.toString(), ssl: { rejectUnauthorized: false } };
  if (mode !== 'verify') throw new Error('DATABASE_SSL is off, require or verify.');
  const caFile = process.env.DATABASE_CA_FILE;
  if (!caFile) throw new Error('DATABASE_SSL=verify needs DATABASE_CA_FILE.');
  // Relative to the repo root, where .env is, whichever folder npm runs from.
  const ca = readFileSync(resolve(fileURLToPath(new URL('../../', import.meta.url)), caFile), 'utf8');
  return { connectionString: u.toString(), ssl: { ca, rejectUnauthorized: true } };
}
