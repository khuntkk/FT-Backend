// Time-based one-time passwords (RFC 6238) for authenticator apps: HMAC-SHA1,
// 30-second steps, six digits — what Google Authenticator, Microsoft
// Authenticator, Authy and 1Password all read. A few lines of node:crypto.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new RangeError('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 bits, as RFC 4226 recommends. */
export const newSecret = (): string => base32Encode(randomBytes(20));

/** The code for one 30-second step (RFC 4226's HOTP with the step as counter). */
export function codeAt(secret: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const n = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * The step a code is valid for — this one or either neighbour, for a phone
 * clock a little off — or null.
 */
export function matchingStep(secret: string, code: string, now = Date.now()): number | null {
  const given = Buffer.from(code.replace(/\s/g, ''));
  if (given.length !== DIGITS) return null;
  const current = stepAt(now);
  for (const step of [current, current - 1, current + 1]) {
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), given)) return step;
  }
  return null;
}

/** What an authenticator app scans (as a QR code) or is given by hand. */
export function otpauthUrl(secret: string, account: string): string {
  const label = encodeURIComponent(`StitchFlow:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=StitchFlow&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
