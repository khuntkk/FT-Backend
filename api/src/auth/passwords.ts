// Passwords: argon2id, and the temporary passwords the owner and our support
// hand out, shown once.

import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** The password the apps' seeded demo accounts share (apps README). Never a real one. */
export const DEMO_PASSWORD = 'Admin@936!';
export const MIN_PASSWORD_LENGTH = 8;

// Algorithm 2 is argon2id. The library's defaults (19 MiB, t=2, p=1) are
// OWASP's recommended minimum.
export const hashPassword = (password: string): Promise<string> => hash(password, { algorithm: 2 });

export async function checkPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Why a new password is refused, in AuthFailure's words — or null. */
export function passwordProblem(next: string): 'tooShort' | 'demoPassword' | null {
  if (next.length < MIN_PASSWORD_LENGTH) return 'tooShort';
  if (next === DEMO_PASSWORD) return 'demoPassword';
  return null;
}

// No 0/O, 1/l/I: it is read off a screen and typed on a phone.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Ten characters, at least one digit. */
export function temporaryPassword(): string {
  let s = '';
  for (let i = 0; i < 9; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s + String(randomInt(2, 10));
}
