// The web admin panel (API.md §4, HANDOVER §5 and §10). Runs as the
// stitchflow_platform role, which sees every property, so unlike the apps'
// services every query here names the property it means.
//
// The console works on structure — properties, who signs in, which role —
// never on a unit's pay, slips or attendance; nothing here reads them.

import type {
  AuditEntry, AuditPage, CreatePropertyInput, CreatedPlatformStaff, CreatedProperty, Member,
  PlatformRole, PlatformStaffInput, PlatformStaffMember, PlatformUser, Property, PropertyDetail,
  PropertyPatch, PropertyStatus, PropertySummary, User,
} from '@stitchflow/contract';
import { todayIn } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError, invalid, notFound, onConstraint } from '../http/errors.ts';
import { hashPassword, temporaryPassword } from '../auth/passwords.ts';
import { DEFAULT_DAY_START, presetShifts } from '../domain/shifts.ts';
import { revokeUserSessions } from './auth.ts';
import { MEMBER_COLUMNS, USER_COLUMNS, getMember, getProperty, getSettings, getUser } from './shapes.ts';

// The same rules the tables check, so a bad field is named rather than
// reported as a bare constraint.
const CODE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const isMachineLimit = (n: number) => Number.isInteger(n) && n >= 0 && n <= 9999;
const fits = (s: string, max: number) => s.trim().length >= 1 && s.trim().length <= max;

/** `%text%` for ilike, with the user's own % and _ taken literally. */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** A new temporary password for a user, who must replace it at the next sign-in. Returns it, for showing once. */
async function issueTemporaryPassword(tx: Tx, userId: number): Promise<string> {
  const password = temporaryPassword();
  await tx.exec(`update users set password_hash = $2, must_change_password = true where id = $1`,
    [userId, await hashPassword(password)]);
  return password;
}

interface NewUser {
  displayName: string;
  phone?: string | null;
  email?: string | null;
}

/**
 * The user with this phone (or email), or a new one. A new user, or one
 * invited without a password yet, gets a temporary password. A user who
 * already has a password of their own keeps it — they may be signed in to
 * another unit with it, and replacing it would lock them out there — and
 * temporaryPassword is then "": the contract's field is a plain string, and
 * the console shows "signs in with their existing password" for an empty one.
 */
async function findOrCreateUser(
  tx: Tx, by: 'phone' | 'email', input: NewUser, emailField: string,
): Promise<{ userId: number; temporaryPassword: string }> {
  const found = await tx.one<{ id: number; has_password: boolean }>(
    `select id, password_hash is not null as has_password from users where ${by} = $1`, [input[by]]);
  if (found) {
    return { userId: found.id, temporaryPassword: found.has_password ? '' : await issueTemporaryPassword(tx, found.id) };
  }
  const password = temporaryPassword();
  const created = await onConstraint(tx.one<{ id: number }>(
    `insert into users (display_name, phone, email, password_hash, must_change_password)
     values ($1, $2, $3, $4, true) returning id`,
    [input.displayName.trim(), input.phone ?? null, input.email ?? null, await hashPassword(password)],
  ), 'users_email_key', () => invalid({ [emailField]: 'taken' }, 'That email belongs to another user.'));
  return { userId: created!.id, temporaryPassword: password };
}

// --- Properties ---------------------------------------------------------------

// lastActivityAt is the last time any of the property's members signed in
// or refreshed a session (every 15 minutes of use): it says whether the
// unit is using the app, which the console's list is for. Console changes
// to the property do not count.
const SUMMARY_SQL = `
  select p.id, p.code::text as code, p.name, p.status, p.machine_limit as "machineLimit",
         (select count(*)::int from property_members m where m.property_id = p.id) as "memberCount",
         a.machines_used as "machineCount",
         (select max(greatest(s.created_at, s.last_used_at))
          from auth_sessions s join property_members m on m.id = s.member_id
          where m.property_id = p.id) as "lastActivityAt"
  from properties p
  join vw_machine_allowance a on a.property_id = p.id`;

export function listProperties(
  tx: Tx, q: { query?: string; status?: PropertyStatus },
): Promise<PropertySummary[]> {
  return tx.rows<PropertySummary>(
    `${SUMMARY_SQL}
     where ($1::text is null or p.name ilike $1 or p.code::text ilike $1)
       and ($2::text is null or p.status = $2)
     order by p.name, p.id`,
    [q.query?.trim() ? contains(q.query.trim()) : null, q.status ?? null],
  );
}

async function propertyOr404(tx: Tx, id: number): Promise<Property> {
  const p = await getProperty(tx, id);
  if (!p) throw notFound('No such property.');
  return p;
}

export async function getPropertyDetail(tx: Tx, id: number): Promise<PropertyDetail> {
  const property = await propertyOr404(tx, id);
  const members = await tx.rows<Member>(
    `select ${MEMBER_COLUMNS} from property_members m join users u on u.id = m.user_id
     where m.property_id = $1 order by m.is_owner desc, u.display_name, m.id`,
    [id],
  );
  const counts = await tx.one<{ machineCount: number; staffCount: number }>(
    `select a.machines_used as "machineCount",
            (select count(*)::int from staff s where s.property_id = $1 and s.deleted_at is null) as "staffCount"
     from vw_machine_allowance a where a.property_id = $1`,
    [id],
  );
  return { property, settings: (await getSettings(tx, id))!, members, ...counts! };
}

function checkCreateInput(input: CreatePropertyInput): void {
  const fields: Record<string, string> = {};
  if (!CODE.test(input.code)) fields.code = 'pattern';
  if (!fits(input.name, 120)) fields.name = 'length';
  if (input.timezone !== undefined && !isTimeZone(input.timezone)) fields.timezone = 'unknown';
  if (!isMachineLimit(input.machineLimit)) fields.machineLimit = 'range';
  if (!fits(input.owner.displayName, 80)) fields['owner.displayName'] = 'length';
  if (!PHONE.test(input.owner.phone)) fields['owner.phone'] = 'pattern';
  if (input.owner.email != null && !EMAIL.test(input.owner.email)) fields['owner.email'] = 'pattern';
  if (Object.keys(fields).length) throw invalid(fields);
}

/** The property, its settings, the preset day/night shifts from today, and its owner. */
export async function createProperty(tx: Tx, input: CreatePropertyInput): Promise<CreatedProperty> {
  checkCreateInput(input);
  const timezone = input.timezone ?? 'Asia/Kolkata';
  const row = await onConstraint(tx.one<{ id: number }>(
    `insert into properties (code, name, timezone, machine_limit) values ($1, $2, $3, $4) returning id`,
    [input.code, input.name.trim(), timezone, input.machineLimit],
  ), 'properties_code_key', () => invalid({ code: 'taken' }, `The code ${input.code} is taken.`));
  const propertyId = row!.id;

  await tx.exec(
    `insert into property_settings (property_id, business_name, shift_scheme, day_start_minute)
     values ($1, $2, 'dayNight', $3)`,
    [propertyId, input.name.trim(), DEFAULT_DAY_START],
  );
  const shifts = presetShifts('dayNight', DEFAULT_DAY_START);
  await tx.exec(
    `insert into shifts (property_id, name, start_minute, duration_minutes, sort_order, effective_from)
     select $1, s.name, s.start_minute, s.duration_minutes, s.ord - 1, $5::date
     from unnest($2::text[], $3::int[], $4::int[]) with ordinality as s(name, start_minute, duration_minutes, ord)`,
    [propertyId, shifts.map((s) => s.name), shifts.map((s) => s.startMinute), shifts.map((s) => s.durationMinutes),
     todayIn(timezone)],
  );

  const owner = await findOrCreateUser(tx, 'phone', {
    displayName: input.owner.displayName, phone: input.owner.phone, email: input.owner.email,
  }, 'owner.email');
  const member = await tx.one<{ id: number }>(
    `insert into property_members (property_id, user_id, role, is_owner)
     values ($1, $2, 'superAdmin', true) returning id`,
    [propertyId, owner.userId],
  );
  return {
    property: (await getProperty(tx, propertyId))!,
    owner: (await getMember(tx, member!.id))!,
    temporaryPassword: owner.temporaryPassword,
  };
}

const PROPERTY_PATCHABLE: Record<string, string> = {
  name: 'name', timezone: 'timezone', status: 'status', machineLimit: 'machine_limit',
};

function checkPatch(patch: PropertyPatch): void {
  const fields: Record<string, string> = {};
  if (patch.name !== undefined && !fits(patch.name, 120)) fields.name = 'length';
  if (patch.timezone !== undefined && !isTimeZone(patch.timezone)) fields.timezone = 'unknown';
  if (patch.machineLimit !== undefined && !isMachineLimit(patch.machineLimit)) fields.machineLimit = 'range';
  if (Object.keys(fields).length) throw invalid(fields);
}

/**
 * Renames, re-zones, suspends or reactivates, or sets the machine limit.
 * A limit below the machines the unit has removes nothing (HANDOVER §5).
 * Returns the property before and after, for the audit row.
 */
export async function updateProperty(
  tx: Tx, id: number, patch: PropertyPatch,
): Promise<{ before: Property; after: Property }> {
  checkPatch(patch);
  const before = await propertyOr404(tx, id);
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [key, column] of Object.entries(PROPERTY_PATCHABLE)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    values.push(key === 'name' ? (value as string).trim() : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length) await tx.exec(`update properties set ${sets.join(', ')} where id = $1`, values);
  // A unit that is not active cannot be used; its members sign in again
  // once it is reactivated. Access tokens still running are refused by the
  // router's status check until they expire.
  if (patch.status && patch.status !== 'active') {
    await tx.exec(
      `update auth_sessions set revoked_at = now(), revoked_reason = 'propertySuspended'
       where revoked_at is null and member_id in (select id from property_members where property_id = $1)`,
      [id],
    );
  }
  return { before, after: (await getProperty(tx, id))! };
}

/** Moves ownership to another super admin of the property. Returns the old and new owner's member ids. */
export async function transferOwnership(
  tx: Tx, propertyId: number, toMemberId: number,
): Promise<{ from: number | null; to: number }> {
  const to = await tx.one<{ role: string; status: string; is_owner: boolean }>(
    `select role, status, is_owner from property_members where id = $1 and property_id = $2`,
    [toMemberId, propertyId],
  );
  if (!to) throw notFound('No such member in this property.');
  if (to.role !== 'superAdmin') {
    throw invalid({ toMemberId: 'notSuperAdmin' }, 'Ownership goes only to a super admin.');
  }
  if (to.status !== 'active') throw invalid({ toMemberId: 'disabled' }, 'That member is switched off.');
  if (to.is_owner) return { from: toMemberId, to: toMemberId };
  // At most one owner per property (property_members_one_owner): clear first.
  const from = await tx.one<{ id: number }>(
    `update property_members set is_owner = false where property_id = $1 and is_owner returning id`, [propertyId]);
  await tx.exec(`update property_members set is_owner = true where id = $1`, [toMemberId]);
  return { from: from?.id ?? null, to: toMemberId };
}

// --- Users --------------------------------------------------------------------

// Membership has no instants, so it can be built as JSON; the user's own
// columns stay top-level so lastLoginAt arrives with a Z.
const PLATFORM_USER_SQL = `
  select ${USER_COLUMNS},
         (select coalesce(json_agg(json_build_object(
                   'memberId', fm.member_id, 'propertyId', fm.property_id, 'propertyCode', fm.property_code,
                   'propertyName', fm.property_name, 'role', fm.role, 'isOwner', fm.is_owner, 'status', fm.status)
                   order by fm.property_name, fm.member_id), '[]'::json)
          from fn_user_memberships(u.id) fm) as memberships,
         (select count(*)::int from auth_sessions s
          where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as "liveSessions"
  from users u`;

type PlatformUserRow = User & Pick<PlatformUser, 'memberships' | 'liveSessions'>;
const toPlatformUser = ({ memberships, liveSessions, ...user }: PlatformUserRow): PlatformUser =>
  ({ user, memberships, liveSessions });

/** Anyone whose phone, email, username or name contains the text. The first 50. */
export async function searchUsers(tx: Tx, query: string): Promise<PlatformUser[]> {
  if (!query.trim()) return [];
  const rows = await tx.rows<PlatformUserRow>(
    `${PLATFORM_USER_SQL}
     where u.display_name ilike $1 or u.username::text ilike $1 or u.email::text ilike $1 or u.phone ilike $1
     order by u.display_name, u.id limit 50`,
    [contains(query.trim())],
  );
  return rows.map(toPlatformUser);
}

export async function getPlatformUser(tx: Tx, id: number): Promise<PlatformUser> {
  const row = await tx.one<PlatformUserRow>(`${PLATFORM_USER_SQL} where u.id = $1`, [id]);
  if (!row) throw notFound('No such user.');
  return toPlatformUser(row);
}

async function userOr404(tx: Tx, id: number): Promise<User> {
  const u = await getUser(tx, id);
  if (!u) throw notFound('No such user.');
  return u;
}

/**
 * A temporary password, and every session ended. Support may reset a
 * unit's user but not one of our own staff: that would hand support an
 * admin's sign-in.
 */
export async function resetPassword(tx: Tx, actorRole: PlatformRole, id: number): Promise<string> {
  await userOr404(tx, id);
  if (actorRole !== 'admin') {
    const staff = await tx.one(`select 1 from platform_staff where user_id = $1`, [id]);
    if (staff) throw new ApiError('forbidden', 'Only a console admin resets console staff.', { platformRole: 'admin' });
  }
  const password = await issueTemporaryPassword(tx, id);
  await revokeUserSessions(tx, id, 'passwordReset');
  return password;
}

/** Switches a user off or on in every property. Off ends their sessions. Returns before and after. */
export async function setUserStatus(
  tx: Tx, actorUserId: number, id: number, status: 'active' | 'disabled',
): Promise<{ before: User; after: User }> {
  const before = await userOr404(tx, id);
  if (status === 'disabled' && id === actorUserId) throw invalid({ id: 'self' }, 'You cannot switch yourself off.');
  await tx.exec(`update users set status = $2 where id = $1`, [id, status]);
  if (status === 'disabled') await revokeUserSessions(tx, id, 'disabled');
  return { before, after: (await getUser(tx, id))! };
}

export async function signOutEverywhere(tx: Tx, id: number): Promise<number> {
  await userOr404(tx, id);
  return revokeUserSessions(tx, id, 'signedOutBySupport');
}

// --- Audit log ----------------------------------------------------------------

export interface AuditQuery {
  propertyId?: number;
  actorUserId?: number;
  from?: string;
  to?: string;
  destructive?: boolean;
  limit?: number;
  cursor?: string;
}

// The cursor is the id of the last entry on the page; the next page starts
// below that entry's (occurred_at, id). Opaque to the console.
const encodeCursor = (id: number) => Buffer.from(String(id)).toString('base64url');
function decodeCursor(cursor: string): number {
  const s = Buffer.from(cursor, 'base64url').toString();
  if (!/^[1-9][0-9]{0,15}$/.test(s)) throw invalid({ cursor: 'invalid' });
  return Number(s);
}

/** Newest first. from/to are UTC dates, both inclusive. */
export async function listAudit(tx: Tx, q: AuditQuery): Promise<AuditPage> {
  const limit = q.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid({ limit: 'range' }, 'limit is 1 to 500.');
  const rows = await tx.rows<AuditEntry>(
    `select a.id, a.occurred_at as "occurredAt", a.property_id as "propertyId", a.actor_user_id as "actorUserId",
            a.actor_member_id as "actorMemberId", a.actor_platform_role as "actorPlatformRole", a.action,
            a.entity_type as "entityType", a.entity_id as "entityId", a.destructive, a.before, a.after,
            a.request_id as "requestId"
     from audit_log a
     where ($1::bigint is null or a.property_id = $1)
       and ($2::bigint is null or a.actor_user_id = $2)
       and ($3::date is null or a.occurred_at >= $3::date::timestamp at time zone 'UTC')
       and ($4::date is null or a.occurred_at < ($4::date + 1)::timestamp at time zone 'UTC')
       and ($5::boolean is null or a.destructive = $5)
       and ($6::bigint is null or (a.occurred_at, a.id) < (select c.occurred_at, c.id from audit_log c where c.id = $6))
     order by a.occurred_at desc, a.id desc
     limit $7`,
    [q.propertyId ?? null, q.actorUserId ?? null, q.from ?? null, q.to ?? null, q.destructive ?? null,
     q.cursor ? decodeCursor(q.cursor) : null, limit + 1],
  );
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, nextCursor: more ? encodeCursor(items[items.length - 1].id) : null };
}

// --- Our console staff --------------------------------------------------------

const STAFF_SQL = `
  select ps.user_id as "userId", u.display_name as "displayName", u.email::text as email, ps.role
  from platform_staff ps join users u on u.id = ps.user_id`;

export function listStaff(tx: Tx): Promise<PlatformStaffMember[]> {
  return tx.rows<PlatformStaffMember>(`${STAFF_SQL} order by u.display_name, ps.user_id`);
}

async function getStaff(tx: Tx, userId: number): Promise<PlatformStaffMember | undefined> {
  return tx.one<PlatformStaffMember>(`${STAFF_SQL} where ps.user_id = $1`, [userId]);
}

/**
 * Makes a console user: a new user, or the existing one with that email.
 * createdBy is null for the first admin, made by the create-platform-admin
 * script because no one can sign in to make them.
 */
export async function addStaff(
  tx: Tx, createdBy: number | null, input: PlatformStaffInput,
): Promise<CreatedPlatformStaff> {
  const fields: Record<string, string> = {};
  if (!fits(input.displayName, 80)) fields.displayName = 'length';
  if (!EMAIL.test(input.email)) fields.email = 'pattern';
  if (Object.keys(fields).length) throw invalid(fields);

  const user = await findOrCreateUser(tx, 'email', input, 'email');
  const added = await tx.exec(
    `insert into platform_staff (user_id, role, created_by) values ($1, $2, $3) on conflict do nothing`,
    [user.userId, input.role, createdBy],
  );
  if (!added) throw invalid({ email: 'alreadyStaff' }, 'That user is already console staff.');
  return { staff: (await getStaff(tx, user.userId))!, temporaryPassword: user.temporaryPassword };
}

/** Ends someone's console access; their user, and any memberships, stay. Returns them as they were. */
export async function removeStaff(tx: Tx, actorUserId: number, userId: number): Promise<PlatformStaffMember> {
  if (userId === actorUserId) throw invalid({ id: 'self' }, 'You cannot remove yourself.');
  const before = await getStaff(tx, userId);
  if (!before) throw notFound('No such console user.');
  await tx.exec(`delete from platform_staff where user_id = $1`, [userId]);
  await tx.exec(
    `update auth_sessions set revoked_at = now(), revoked_reason = 'staffRemoved'
     where user_id = $1 and client = 'webAdmin' and revoked_at is null`,
    [userId],
  );
  return before;
}
