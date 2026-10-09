// Sign-in and sessions (API.md §2, HANDOVER §9).
//
// A session is one signed-in device: an auth_sessions row holding the hash
// of its refresh token. Refreshing rotates the token within the session's
// family; presenting a token that was already rotated away means it was
// copied, so the whole family is revoked.

import type {
  ClientKind, LoginInput, LoginResult, Membership, PlatformLoginInput, PlatformRole, TokenPair, UserRole,
} from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError } from '../http/errors.ts';
import { checkPassword, hashPassword, passwordProblem } from '../auth/passwords.ts';
import {
  ACCESS_TOKEN_SECONDS, hashToken, newRefreshToken, signAccessToken, type AccessClaims,
} from '../auth/tokens.ts';
import * as platformTotp from './platformTotp.ts';
import { getUser } from './shapes.ts';
import {
  assertSignInInputSize, identifierColumn, recordSignInFailure, recordSignInSuccess, signInKeys, totpByUser,
} from './rateLimit.ts';

const SESSION_DAYS = 7;
const KEEP_SIGNED_IN_DAYS = 15;

interface MembershipRow {
  member_id: number;
  property_id: number;
  property_code: string;
  property_name: string;
  property_status: string;
  role: UserRole;
  is_owner: boolean;
  status: 'active' | 'disabled';
}

const toMembership = (r: MembershipRow): Membership => ({
  memberId: r.member_id,
  propertyId: r.property_id,
  propertyCode: r.property_code,
  propertyName: r.property_name,
  role: r.role,
  isOwner: r.is_owner,
  status: r.status,
});

const usable = (r: MembershipRow) => r.status === 'active' && r.property_status === 'active';

// fn_user_memberships is security definer: memberships are hidden by
// row-level security until a property is chosen.
const memberships = (tx: Tx, userId: number) =>
  tx.rows<MembershipRow>(`select * from fn_user_memberships($1)`, [userId]);

interface SessionSpec {
  userId: number;
  memberId: number | null;
  client: ClientKind;
  keepSignedIn: boolean;
  familyId?: string;
  deviceLabel?: string | null;
}

/** Opens a session and returns its token pair. */
async function openSession(
  tx: Tx,
  secret: string,
  s: SessionSpec,
  claims: Omit<AccessClaims, 'sid' | 'sub' | 'client'>,
): Promise<TokenPair> {
  const refreshToken = newRefreshToken();
  const days = s.keepSignedIn ? KEEP_SIGNED_IN_DAYS : SESSION_DAYS;
  const row = await tx.one<{ id: string }>(
    `insert into auth_sessions (user_id, member_id, client, refresh_token_hash, family_id,
                                keep_signed_in, device_label, expires_at)
     values ($1, $2, $3, $4, coalesce($5::uuid, gen_random_uuid()), $6, $7, now() + make_interval(days => $8))
     returning id`,
    [s.userId, s.memberId, s.client, hashToken(refreshToken), s.familyId ?? null, s.keepSignedIn,
     s.deviceLabel?.slice(0, 200) ?? null, days],
  );
  const accessToken = signAccessToken({ ...claims, sub: s.userId, sid: row!.id, client: s.client }, secret);
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_SECONDS };
}

const memberClaims = (m: MembershipRow | null) => ({
  mid: m?.member_id ?? null,
  pid: m?.property_id ?? null,
  role: m?.role ?? null,
});

/**
 * Checks identifier and password, counting failures. Returns the user's id.
 * The limits were checked in dispatch; an unknown user and a wrong password
 * fail the same way, after the same argon2 work.
 */
async function authenticate(tx: Tx, column: string, identifier: string, password: string, ip: string) {
  assertSignInInputSize(identifier, password);
  const keys = signInKeys(column, identifier, ip);
  const u = await tx.one<{ id: number; password_hash: string | null; status: string }>(
    `select id, password_hash, status from users where ${column} = $1`,
    [identifier],
  );
  if (!(await checkPassword(u?.password_hash ?? null, password)) || !u) {
    recordSignInFailure(keys);
    throw new ApiError('unauthenticated', 'Phone, email or password is not right.', { reason: 'wrongPassword' });
  }
  recordSignInSuccess(keys);
  if (u.status !== 'active') throw new ApiError('unauthenticated', 'This account is switched off.', { reason: 'disabled' });
  await tx.exec(`update users set last_login_at = now() where id = $1`, [u.id]);
  return u.id;
}

export async function login(
  tx: Tx, secret: string, input: LoginInput, ip: string, deviceLabel: string | null,
): Promise<LoginResult> {
  if (input.client === 'webAdmin') {
    throw new ApiError('validation_failed', 'The web admin panel signs in at /v1/platform/auth/login.', {
      fields: { client: 'webAdmin' },
    });
  }
  const identifier = input.identifier.trim();
  const userId = await authenticate(tx, identifierColumn(identifier), identifier, input.password, ip);
  const all = await memberships(tx, userId);
  const live = all.filter(usable);
  const chosen = live.length === 1 ? live[0] : null;
  const pair = await openSession(tx, secret, {
    userId, memberId: chosen?.member_id ?? null, client: input.client,
    keepSignedIn: input.keepSignedIn, deviceLabel,
  }, memberClaims(chosen));
  return {
    ...pair,
    user: (await getUser(tx, userId))!,
    memberships: all.map(toMembership),
    activeMember: chosen ? toMembership(chosen) : null,
  };
}

export async function platformLogin(
  tx: Tx, secret: string, input: PlatformLoginInput, ip: string, deviceLabel: string | null,
): Promise<TokenPair> {
  const email = input.email.trim();
  const userId = await authenticate(tx, 'email', email, input.password, ip);
  const staff = await tx.one<{ role: PlatformRole }>(`select role from platform_staff where user_id = $1`, [userId]);
  if (!staff) throw new ApiError('forbidden', 'Not console staff.');
  // Wrong codes have their own, stricter counter: 5 per 15 minutes per user.
  totpByUser.assertAllowed(String(userId));
  const totp = await platformTotp.checkAtSignIn(tx, userId, input.totpCode);
  if (totp === 'wrongTotp') totpByUser.recordFailure(String(userId));
  else if (!totp) totpByUser.reset(String(userId));
  if (totp) {
    throw new ApiError('unauthenticated', totp === 'totpRequired'
      ? 'Enter the code from your authenticator app.' : 'That code does not match.', { reason: totp });
  }
  return openSession(tx, secret, { userId, memberId: null, client: 'webAdmin', keepSignedIn: false, deviceLabel },
    { mid: null, pid: null, role: null, prole: staff.role });
}

export async function selectProperty(tx: Tx, secret: string, claims: AccessClaims, memberId: number) {
  const m = (await memberships(tx, claims.sub)).find((r) => r.member_id === memberId);
  if (!m) throw new ApiError('not_found', 'No such membership.');
  if (m.property_status !== 'active') throw new ApiError('property_suspended', 'This unit is not active.');
  if (m.status !== 'active') throw new ApiError('forbidden', 'This membership is switched off.');
  const s = await tx.one<{ family_id: string; keep_signed_in: boolean; client: ClientKind; device_label: string | null }>(
    `update auth_sessions set revoked_at = now(), revoked_reason = 'switched'
     where id = $1 and user_id = $2 and revoked_at is null
     returning family_id, keep_signed_in, client, device_label`,
    [claims.sid, claims.sub],
  );
  if (!s) throw new ApiError('unauthenticated', 'This session has ended.');
  return openSession(tx, secret, {
    userId: claims.sub, memberId, client: s.client, keepSignedIn: s.keep_signed_in,
    familyId: s.family_id, deviceLabel: s.device_label,
  }, memberClaims(m));
}

interface SessionRow {
  id: string; user_id: number; member_id: number | null; client: ClientKind; family_id: string;
  keep_signed_in: boolean; device_label: string | null; revoked_at: string | null;
  revoked_reason: string | null; expired: boolean; user_status: string; recent: boolean;
}

/** One session row, locked, with whether it was revoked in the last minute. */
const findSession = (tx: Tx, where: string, ...params: unknown[]) =>
  tx.one<SessionRow>(
    `select s.*, s.expires_at <= now() as expired, u.status as user_status,
            s.revoked_at > now() - interval '60 seconds' as recent
     from auth_sessions s join users u on u.id = s.user_id
     where ${where} for update of s`,
    params,
  );

/**
 * A new pair for a refresh token — or 'reused' when the token was already
 * rotated away, after revoking its family. That is a 401 to the client, but
 * the revocation must commit, so it is returned rather than thrown.
 */
export async function refresh(tx: Tx, secret: string, refreshToken: string): Promise<TokenPair | 'reused'> {
  let graceRetry = false;
  let s = await findSession(tx, `s.refresh_token_hash = $1`, hashToken(refreshToken));
  if (!s) throw new ApiError('unauthenticated', 'Unknown refresh token.');
  if (s.revoked_at) {
    if (s.revoked_reason === 'rotated' || s.revoked_reason === 'switched') {
      // Rotated away moments ago, and the pair it was rotated to is still live:
      // the reply was probably lost and this is the client's retry. Rotate that
      // child instead. Anything else was copied: end the family.
      const child = s.recent
        ? await findSession(tx, `s.family_id = $1 and s.revoked_at is null and s.created_at >= (select revoked_at from auth_sessions where id = $2)
                                 order by s.created_at desc limit 1`, s.family_id, s.id)
        : null;
      if (!child) {
        await revokeFamily(tx, s.family_id, 'reused');
        return 'reused';
      }
      s = child;
      graceRetry = true;
    } else if (s.revoked_reason === 'rotatedRetry') {
      // The pair a retried refresh superseded: the client never received it,
      // so whoever presents it copied it. End the family.
      await revokeFamily(tx, s.family_id, 'reused');
      return 'reused';
    } else {
      throw new ApiError('unauthenticated', 'This session has ended.');
    }
  }
  if (s.expired || s.user_status !== 'active') throw new ApiError('unauthenticated', 'This session has ended.');

  let claims: Omit<AccessClaims, 'sid' | 'sub' | 'client'> = memberClaims(null);
  if (s.member_id !== null) {
    const m = (await memberships(tx, s.user_id)).find((r) => r.member_id === s.member_id);
    if (!m || !usable(m)) throw new ApiError('unauthenticated', 'This session has ended.');
    claims = memberClaims(m);
  } else if (s.client === 'webAdmin') {
    const staff = await tx.one<{ role: PlatformRole }>(`select role from platform_staff where user_id = $1`, [s.user_id]);
    if (!staff) throw new ApiError('unauthenticated', 'This session has ended.');
    claims = { ...claims, prole: staff.role };
  }
  await tx.exec(
    `update auth_sessions set revoked_at = now(), revoked_reason = $2, last_used_at = now() where id = $1`,
    [s.id, graceRetry ? 'rotatedRetry' : 'rotated'],
  );
  return openSession(tx, secret, {
    userId: s.user_id, memberId: s.member_id, client: s.client, keepSignedIn: s.keep_signed_in,
    familyId: s.family_id, deviceLabel: s.device_label,
  }, claims);
}

const revokeFamily = (tx: Tx, familyId: string, reason: string) =>
  tx.exec(`update auth_sessions set revoked_at = now(), revoked_reason = $2
           where family_id = $1 and revoked_at is null`, [familyId, reason]);

export async function logout(tx: Tx, userId: number, refreshToken: string, everywhere: boolean): Promise<void> {
  if (everywhere) {
    await revokeUserSessions(tx, userId, 'logout');
    return;
  }
  await tx.exec(
    `update auth_sessions set revoked_at = now(), revoked_reason = 'logout'
     where refresh_token_hash = $1 and user_id = $2 and revoked_at is null`,
    [hashToken(refreshToken), userId],
  );
}

/** Ends every live session of a user (disable, sign out everywhere). */
export const revokeUserSessions = (tx: Tx, userId: number, reason: string) =>
  tx.exec(`update auth_sessions set revoked_at = now(), revoked_reason = $2
           where user_id = $1 and revoked_at is null`, [userId, reason]);

/** Ends every live session acting as a member (disable, remove). */
export const revokeMemberSessions = (tx: Tx, memberId: number, reason: string) =>
  tx.exec(`update auth_sessions set revoked_at = now(), revoked_reason = $2
           where member_id = $1 and revoked_at is null`, [memberId, reason]);

export async function changePassword(tx: Tx, userId: number, sid: string, current: string, next: string): Promise<void> {
  const u = await tx.one<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [userId]);
  if (!(await checkPassword(u?.password_hash ?? null, current))) {
    throw new ApiError('validation_failed', 'The current password is wrong.', {
      reason: 'wrongPassword', fields: { current: 'wrongPassword' },
    });
  }
  const problem = passwordProblem(next);
  if (problem) {
    throw new ApiError('validation_failed', 'That password cannot be used.', { reason: problem, fields: { next: problem } });
  }
  await tx.exec(`update users set password_hash = $2, must_change_password = false where id = $1`,
    [userId, await hashPassword(next)]);
  // Whoever held the old password may hold a session: end every other device's.
  // `is distinct from` fails closed: an unknown caller family revokes everything.
  await tx.exec(
    `update auth_sessions set revoked_at = now(), revoked_reason = 'passwordChanged'
     where user_id = $1 and revoked_at is null
       and family_id is distinct from (select family_id from auth_sessions where id = $2::uuid)`,
    [userId, sid],
  );
}
