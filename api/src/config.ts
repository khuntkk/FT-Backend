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
  /** Where uploaded photos are kept (local disk; object storage is an open decision). */
  filesDir: string;
  /** Run the daily purge and session expiry inside this process. */
  runJobs: boolean;
  logLevel: string;
  /** Behind a load balancer: trust X-Forwarded-* for the client's IP and scheme. */
  trustProxy: boolean;
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
    runJobs: process.env.RUN_JOBS !== 'false',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    trustProxy: process.env.TRUST_PROXY === 'true',
  };
}
