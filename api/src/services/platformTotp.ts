// Two-factor sign-in for our console staff (0009_platform_totp.sql).
//
// Set up in two steps so a mistyped secret cannot lock anyone out: setup
// issues a secret, enable switches it on once a code from the app matches.
// A code is accepted once: its step must be later than the last one used.

import type { TotpSetup } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { invalid, notFound } from '../http/errors.ts';
import { matchingStep, newSecret, otpauthUrl } from '../auth/totp.ts';

interface StaffTotp {
  email: string | null;
  secret: string | null;
  enabled: boolean;
  lastStep: number | null;
}

async function load(tx: Tx, userId: number): Promise<StaffTotp> {
  const s = await tx.one<StaffTotp>(
    `select u.email::text as email, ps.totp_secret as secret, ps.totp_enabled_at is not null as enabled,
            ps.totp_last_step as "lastStep"
     from platform_staff ps join users u on u.id = ps.user_id where ps.user_id = $1 for update of ps`,
    [userId],
  );
  if (!s) throw notFound('Not console staff.');
  return s;
}

/** The step a fresh code is for, or null if it is wrong or already used. */
function freshStep(s: StaffTotp, code: string): number | null {
  const step = s.secret ? matchingStep(s.secret, code) : null;
  return step !== null && (s.lastStep === null || step > s.lastStep) ? step : null;
}

const useStep = (tx: Tx, userId: number, step: number) =>
  tx.exec(`update platform_staff set totp_last_step = $2 where user_id = $1`, [userId, step]);

export async function setup(tx: Tx, userId: number): Promise<TotpSetup> {
  const s = await load(tx, userId);
  if (s.enabled) throw invalid({ totp: 'alreadyEnabled' }, 'Two-factor sign-in is already on; turn it off first.');
  const secret = newSecret();
  await tx.exec(`update platform_staff set totp_secret = $2, totp_last_step = null where user_id = $1`, [userId, secret]);
  return { secret, otpauthUrl: otpauthUrl(secret, s.email ?? `user-${userId}`) };
}

export async function enable(tx: Tx, userId: number, code: string): Promise<void> {
  const s = await load(tx, userId);
  if (s.enabled) throw invalid({ totp: 'alreadyEnabled' }, 'Two-factor sign-in is already on.');
  if (!s.secret) throw invalid({ totp: 'notSetUp' }, 'Start with setup.');
  const step = freshStep(s, code);
  if (step === null) throw invalid({ code: 'wrongTotp' }, 'That code does not match.');
  await tx.exec(`update platform_staff set totp_enabled_at = now(), totp_last_step = $2 where user_id = $1`,
    [userId, step]);
}

export async function disable(tx: Tx, userId: number, code: string): Promise<void> {
  const s = await load(tx, userId);
  if (!s.enabled) throw invalid({ totp: 'notEnabled' }, 'Two-factor sign-in is not on.');
  if (freshStep(s, code) === null) throw invalid({ code: 'wrongTotp' }, 'That code does not match.');
  await clear(tx, userId);
}

/** An admin turns it off for someone else who lost their phone. */
export async function resetFor(tx: Tx, actorUserId: number, userId: number): Promise<void> {
  if (actorUserId === userId) {
    throw invalid({ id: 'self' }, 'Turn your own off with a code, from your own account.');
  }
  await load(tx, userId);
  await clear(tx, userId);
}

const clear = (tx: Tx, userId: number) =>
  tx.exec(`update platform_staff set totp_secret = null, totp_enabled_at = null, totp_last_step = null
           where user_id = $1`, [userId]);

/**
 * At sign-in, after the password: nothing to do if two-factor is off;
 * otherwise a fresh code is required. Returns why it failed, or null.
 */
export async function checkAtSignIn(tx: Tx, userId: number, code: string | undefined):
  Promise<'totpRequired' | 'wrongTotp' | null> {
  const s = await load(tx, userId);
  if (!s.enabled) return null;
  if (!code) return 'totpRequired';
  const step = freshStep(s, code);
  if (step === null) return 'wrongTotp';
  await useStep(tx, userId, step);
  return null;
}

