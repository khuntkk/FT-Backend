// Failed sign-ins, counted per identifier and per IP in a fixed window; past
// the limit every attempt is refused until the window ends. In memory: right
// for one API process. Several processes would share this through the
// database or Redis.

import { ApiError } from '../http/errors.ts';

const WINDOW_MS = 15 * 60 * 1000;

export class FailureLimiter {
  #fails = new Map<string, { count: number; resetAt: number }>();
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
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

  recordFailure(key: string, now = Date.now()): void {
    let f = this.#fails.get(key);
    if (!f || f.resetAt <= now) {
      f = { count: 0, resetAt: now + WINDOW_MS };
      this.#fails.set(key, f);
    }
    f.count++;
    if (this.#fails.size > 50_000) {
      for (const [k, v] of this.#fails) if (v.resetAt <= now) this.#fails.delete(k);
    }
  }

  clear(): void {
    this.#fails.clear();
  }
}

export const signInByIdentifier = new FailureLimiter(10);
export const signInByIp = new FailureLimiter(50);
