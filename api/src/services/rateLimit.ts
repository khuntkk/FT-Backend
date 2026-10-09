// Failed sign-ins, counted in fixed windows. In memory: right for one API
// process. Several processes would share this through the database or Redis.
//
//   pair        identifier + IP, 10 per 15 min, then refused (429). Keyed on
//               the pair so a stranger cannot lock a real user out.
//   identifier  all IPs together: from the 5th failure on each attempt waits
//               a little longer (progressive delay, never a refusal). A high
//               daily count is only logged.
//   ip          200 per 15 min across all identifiers (a unit behind one NAT).
//   totp        wrong console two-factor codes, 5 per 15 min per user.
//
// The checks run in dispatch before a database connection is taken, so a
// refused request costs no round trip.

import { ApiError } from '../http/errors.ts';

const WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 50_000;

export const MAX_IDENTIFIER_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 256;

export class FailureLimiter {
  #fails = new Map<string, { count: number; resetAt: number }>();
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs = WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Failures so far in this key's window. */
  count(key: string, now = Date.now()): number {
    const f = this.#fails.get(key);
    return f && f.resetAt > now ? f.count : 0;
  }

  /** 429 rate_limited if the key has failed too often in this window. */
  assertAllowed(key: string, now = Date.now()): void {
    const f = this.#fails.get(key);
    if (f && f.resetAt > now && f.count >= this.limit) {
      throw new ApiError('rate_limited', 'Too many sign-in attempts.', {
        retryAfter: Math.ceil((f.resetAt - now) / 1000),
      });
    }
  }

  /** Returns the failures in the window, this one included. */
  recordFailure(key: string, now = Date.now()): number {
    let f = this.#fails.get(key);
    if (!f || f.resetAt <= now) {
      f = { count: 0, resetAt: now + this.windowMs };
      this.#fails.set(key, f);
    }
    f.count++;
    if (this.#fails.size > MAX_KEYS) {
      for (const [k, v] of this.#fails) if (v.resetAt <= now) this.#fails.delete(k);
    }
    return f.count;
  }

  reset(key: string): void {
    this.#fails.delete(key);
  }

  clear(): void {
    this.#fails.clear();
  }
}

export const signInByPair = new FailureLimiter(10);
export const signInByIdentifier = new FailureLimiter(Infinity);
export const signInByIdentifierDay = new FailureLimiter(100, DAY_MS);
export const signInByIp = new FailureLimiter(200);
export const totpByUser = new FailureLimiter(5);

export const clearSignInLimits = () => {
  for (const l of [signInByPair, signInByIdentifier, signInByIdentifierDay, signInByIp, totpByUser]) l.clear();
};

/** A phone starts with +, an email has an @, anything else is a username. */
export function identifierColumn(identifier: string): 'phone' | 'email' | 'username' {
  if (identifier.startsWith('+')) return 'phone';
  if (identifier.includes('@')) return 'email';
  return 'username';
}

/**
 * The address to count: an IPv6 client is a whole /64 (one subscriber has
 * billions of addresses); a v4-mapped one is its IPv4.
 */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('%')[0]!.split('::') as [string?, string?];
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export interface SignInKeys {
  id: string;
  pair: string;
  ip: string;
}

export const signInKeys = (column: string, identifier: string, ip: string): SignInKeys => {
  const nip = normalizeIp(ip);
  const id = `${column}:${identifier.toLowerCase()}`;
  return { id, pair: `${id}|${nip}`, ip: nip };
};

const tooLong = () =>
  new ApiError('unauthenticated', 'Phone, email or password is not right.', { reason: 'wrongPassword' });

/** Generic 401 for input no account could have, before it becomes a Map key or reaches argon2. */
export function assertSignInInputSize(identifier: string, password: string): void {
  if (identifier.length > MAX_IDENTIFIER_LENGTH || password.length > MAX_PASSWORD_LENGTH) throw tooLong();
}

/** 5th failure on: 250 ms, doubling, at most 5 s. */
export const delayMs = (failures: number): number =>
  failures < 5 ? 0 : Math.min(250 * 2 ** (failures - 5), 5000);

/**
 * Before any database work on a sign-in route: refuses when a limit is hit
 * and returns how long to wait before the password check. Synchronous.
 * `identifier` is null for routes that carry none (refresh).
 */
export function signInPreflight(
  identifier: { column: string; value: string; password: string } | null, ip: string,
): number {
  if (!identifier) {
    signInByIp.assertAllowed(normalizeIp(ip));
    return 0;
  }
  assertSignInInputSize(identifier.value, identifier.password);
  const k = signInKeys(identifier.column, identifier.value, ip);
  signInByIp.assertAllowed(k.ip);
  signInByPair.assertAllowed(k.pair);
  return delayMs(signInByIdentifier.count(k.id));
}

export function recordSignInFailure(k: SignInKeys): void {
  signInByPair.recordFailure(k.pair);
  signInByIp.recordFailure(k.ip);
  signInByIdentifier.recordFailure(k.id);
  // Never refuses: a daily tally of one account under attack, for the logs.
  if (signInByIdentifierDay.recordFailure(k.id) === signInByIdentifierDay.limit) {
    console.warn(`sign-in: ${signInByIdentifierDay.limit} failures in a day for ${k.id.split(':')[0]} identifier`);
  }
}

export function recordSignInSuccess(k: SignInKeys): void {
  signInByPair.reset(k.pair);
  signInByIdentifier.reset(k.id);
}
