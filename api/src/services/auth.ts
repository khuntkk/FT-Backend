// Sign-in and sessions (API.md §2, HANDOVER §9).
//
// A session is one signed-in device: an auth_sessions row holding the hash
// of its refresh token. Refreshing rotates the token within the session's
// family; presenting a token that was already rotated away means it was
// copied, so the whole family is revoked.

import type {
  ClientKind, LoginInput, LoginResult, Membership, PlatformRole, TokenPair, UserRole,
} from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError } from '../http/errors.ts';
import { checkPassword, hashPassword, passwordProblem } from '../auth/passwords.ts';
import {
  ACCESS_TOKEN_SECONDS, hashToken, newRefreshToken, signAccessToken, type AccessClaims,
} from '../auth/tokens.ts';
import { getUser } from './shapes.ts';
import { signInByIdentifier, signInByIp } from './rateLimit.ts';

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

/** Which column an identifier names: a phone starts with +, an email has an @. */
function identifierColumn(identifier: string): 'phone' | 'email' | 'username' {
  if (identifier.startsWith('+')) return 'phone';
  if (identifier.includes('@')) return 'email';
  return 'username';
}

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

/** Checks identifier and password, counting failures. Returns the user's id. */
async function authenticate(tx: Tx, column: string, identifier: string, password: string, ip: string) {
  const idKey = `${column}:${identifier.toLowerCase()}`;
  signInByIdentifier.assertAllowed(idKey);
  signInByIp.assertAllowed(ip);
  const u = await tx.one<{ id: number; password_hash: string | null; status: string }>(
    `select id, password_hash, status from users where ${column} = $1`,
    [identifier],
  );
  const fail = (reason: string, message: string) => {
    signInByIdentifier.recordFailure(idKey);
    signInByIp.recordFailure(ip);
    return new ApiError('unauthenticated', message, { reason });
  };
  if (!u) throw fail('noSuchUser', 'No account with that sign-in.');
  if (!(await checkPassword(u.password_hash, password))) throw fail('wrongPassword', 'Wrong password.');
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
  tx: Tx, secret: string, email: string, password: string, ip: string, deviceLabel: string | null,
): Promise<TokenPair> {
  const userId = await authenticate(tx, 'email', email.trim(), password, ip);
  const staff = await tx.one<{ role: PlatformRole }>(`select role from platform_staff where user_id = $1`, [userId]);
  if (!staff) throw new ApiError('forbidden', 'Not console staff.');
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

/**
 * A new pair for a refresh token — or 'reused' when the token was already
 * rotated away, after revoking its family. That is a 401 to the client, but
 * the revocation must commit, so it is returned rather than thrown.
 */
export async function refresh(tx: Tx, secret: string, refreshToken: string): Promise<TokenPair | 'reused'> {
  const s = await tx.one<{
    id: string; user_id: number; member_id: number | null; client: ClientKind; family_id: string;
    keep_signed_in: boolean; device_label: string | null; revoked_at: string | null;
    revoked_reason: string | null; expired: boolean; user_status: string;
  }>(
    `select s.*, s.expires_at <= now() as expired, u.status as user_status
     from auth_sessions s join users u on u.id = s.user_id
     where s.refresh_token_hash = $1 for update of s`,
    [hashToken(refreshToken)],
  );
  if (!s) throw new ApiError('unauthenticated', 'Unknown refresh token.');
  if (s.revoked_at) {
    if (s.revoked_reason === 'rotated' || s.revoked_reason === 'switched') {
      // A token already rotated away was used again: it was copied.
      await revokeFamily(tx, s.family_id, 'reused');
      return 'reused';
    }
    throw new ApiError('unauthenticated', 'This session has ended.');
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
    `update auth_sessions set revoked_at = now(), revoked_reason = 'rotated', last_used_at = now() where id = $1`,
    [s.id],
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

export async function changePassword(tx: Tx, userId: number, current: string, next: string): Promise<void> {
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
}
