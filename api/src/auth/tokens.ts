// Access tokens (JWT, HS256, 15 minutes) and refresh tokens (opaque, 256-bit,
// stored only as a SHA-256 hash). HS256 is a few lines of node:crypto, so no
// library.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ClientKind, PlatformRole, UserRole } from '@stitchflow/contract';
import { ApiError } from '../http/errors.ts';

export const ACCESS_TOKEN_SECONDS = 15 * 60;

export interface AccessClaims {
  /** User id. */
  sub: number;
  /** Session id (auth_sessions.id). */
  sid: string;
  client: ClientKind;
  /** Member and property the token acts in; null until a property is chosen. */
  mid: number | null;
  pid: number | null;
  role: UserRole | null;
  /** Platform staff role, on web admin panel tokens only. */
  prole?: PlatformRole;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export function signAccessToken(claims: AccessClaims, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ ...claims, iat, exp: iat + ACCESS_TOKEN_SECONDS }));
  const sig = createHmac('sha256', secret).update(`${HEADER}.${payload}`).digest('base64url');
  return `${HEADER}.${payload}.${sig}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENTS = ['managerApp', 'crewApp', 'webAdmin'];
const intOrNull = (v: unknown) => v === null || Number.isSafeInteger(v);

function validShape(c: any): boolean {
  return typeof c === 'object' && c !== null && Number.isSafeInteger(c.sub) &&
    typeof c.sid === 'string' && UUID.test(c.sid) && CLIENTS.includes(c.client) &&
    intOrNull(c.mid) && intOrNull(c.pid);
}

/** The claims of a valid token; 401 unauthenticated or token_expired otherwise. */
export function verifyAccessToken(token: string, secret: string, now = Date.now()): AccessClaims {
  const [header, payload, sig] = token.split('.');
  if (!header || !payload || !sig || header !== HEADER) {
    throw new ApiError('unauthenticated', 'Malformed token.');
  }
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApiError('unauthenticated', 'Bad token signature.');
  }
  let claims: AccessClaims & { exp: number };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError('unauthenticated', 'Malformed token.');
  }
  if (!validShape(claims)) throw new ApiError('unauthenticated', 'Malformed token.');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    throw new ApiError('token_expired', 'Access token expired.');
  }
  return claims;
}

export const newRefreshToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
