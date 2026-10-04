// The property's own logins (API.md §3 Users, HANDOVER §5–§6).
//
// Who may create whom is fn_member_can_create; what may be granted is
// fn_can_grant. A creator also manages who they could create — access,
// password, switching off, removing — so every route on one member goes
// through manageable(). Nobody manages the owner: ownership moves only by
// transfer, and the owner cannot be switched off or removed here.
//
// users has no row-level security (a user is global), so a user row is only
// ever reached through a property_members row, which has it.

import type { AccessLevel, CreateUserInput, CreatedUser, Member, ModuleKey, UserRole } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { hashPassword, temporaryPassword } from '../auth/passwords.ts';
import { ApiError, invalid, notFound } from '../http/errors.ts';
import type { Member as Caller } from '../http/types.ts';
import { revokeMemberSessions, revokeUserSessions } from './auth.ts';
import { getMember, MEMBER_COLUMNS } from './shapes.ts';

type Modules = Partial<Record<ModuleKey, AccessLevel>>;

/** Everyone in the unit, switched off included, highest role first. */
export function list(tx: Tx): Promise<Member[]> {
  return tx.rows<Member>(
    `select ${MEMBER_COLUMNS} from property_members m join users u on u.id = m.user_id
     order by m.is_owner desc,
              array_position(array['superAdmin', 'admin', 'viewAdmin', 'supervisor', 'worker'], m.role),
              u.display_name, m.id`,
  );
}

export async function get(tx: Tx, memberId: number): Promise<Member> {
  const m = await getMember(tx, memberId);
  if (!m) throw notFound('No such user.');
  return m;
}

const cannot = (action: string, message: string) => new ApiError('forbidden', message, { action });

/** The member, if the caller may manage them; 403 otherwise. */
async function manageable(tx: Tx, caller: Caller, memberId: number, action: string): Promise<Member> {
  const target = await get(tx, memberId);
  if (target.isOwner) throw cannot(action, 'The owner is changed only by handing the unit over.');
  const row = await tx.one<{ ok: boolean }>(`select fn_member_can_create($1, $2) as ok`, [caller.memberId, target.role]);
  if (!row?.ok) throw cannot(action, `You do not manage a ${target.role}.`);
  return target;
}

/** 409 grant_exceeds_granter for the first module above the granter's level or the role's ceiling. */
async function checkGrants(tx: Tx, granter: number, role: UserRole, modules: Modules) {
  const over = await tx.one<{ module: string; level: string }>(
    `select g.key as module, g.value as level from jsonb_each_text($3::jsonb) g
     where not coalesce(fn_can_grant($1, $2, g.key, g.value), false)
     order by g.key limit 1`,
    [granter, role, JSON.stringify(modules)],
  );
  if (over) {
    throw new ApiError('grant_exceeds_granter', `Cannot give ${over.level} on ${over.module}.`, over);
  }
}

async function saveGrants(tx: Tx, memberId: number, granter: number, modules: Modules) {
  await tx.exec(
    `insert into member_module_access (member_id, module, level, granted_by_member_id)
     select $1, g.key, g.value, $2 from jsonb_each_text($3::jsonb) g
     on conflict (member_id, module) do update
       set level = excluded.level, granted_by_member_id = excluded.granted_by_member_id, granted_at = now()`,
    [memberId, granter, JSON.stringify(modules)],
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function create(tx: Tx, caller: Caller, input: CreateUserInput): Promise<CreatedUser> {
  const may = await tx.one<{ ok: boolean }>(`select fn_member_can_create($1, $2) as ok`, [caller.memberId, input.role]);
  if (!may?.ok) throw cannot('users.create', `You cannot add a ${input.role}.`);
  const modules = input.modules ?? {};
  await checkGrants(tx, caller.memberId, input.role, modules);
  if (input.staffId != null) {
    const s = await tx.one(`select 1 from staff where id = $1 and deleted_at is null`, [input.staffId]);
    if (!s) throw notFound('No such person.');
  }
  const user = await findOrCreateUser(tx, input, caller.propertyId);
  const already = await tx.one(`select 1 from property_members where user_id = $1`, [user.userId]);
  if (already) throw invalid({ [user.matchedOn]: 'alreadyMember' }, 'That person already has a login here.');
  const row = await tx.one<{ id: number }>(
    `insert into property_members (property_id, user_id, role, staff_id, created_by_member_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [caller.propertyId, user.userId, input.role, input.staffId ?? null, caller.memberId],
  );
  await saveGrants(tx, row!.id, caller.memberId, modules);
  return { member: await get(tx, row!.id), temporaryPassword: user.temporaryPassword };
}

const IDENTIFIERS = ['phone', 'email', 'username'] as const;

// The users table's checks, as the field each one is about.
const USER_CHECKS: Record<string, string> = {
  users_display_name_check: 'displayName', users_phone_check: 'phone',
  users_email_check: 'email', users_username_check: 'username',
};

/**
 * The user with this phone, email or username — one login however many
 * units they belong to — or a new one with a temporary password. An
 * existing user keeps their password: temporaryPassword is then "" (as the
 * platform's owner creation does), or anyone who can add users could take
 * over a login from another unit.
 */
async function findOrCreateUser(tx: Tx, input: CreateUserInput, propertyId: number) {
  const given = IDENTIFIERS.filter((k) => input[k] != null && String(input[k]).trim() !== '');
  if (!given.length) throw invalid({ phone: 'required' }, 'Give a phone, email or username.');
  const value = (k: (typeof IDENTIFIERS)[number]) => (given.includes(k) ? String(input[k]).trim() : null);
  const found = await tx.rows<{ id: number; hasPassword: boolean; matchedOn: string }>(
    `select id, password_hash is not null as "hasPassword",
            case when phone = $1 then 'phone' when email = $2 then 'email' else 'username' end as "matchedOn"
     from users where phone = $1 or email = $2 or username = $3`,
    [value('phone'), value('email'), value('username')],
  );
  if (found.length > 1) {
    throw invalid(Object.fromEntries(given.map((k) => [k, 'differentUsers'])),
      'Those sign-ins belong to different people.');
  }
  if (found.length === 1) {
    const { id, hasPassword, matchedOn } = found[0];
    if (await isPlatformStaff(tx, id)) {
      throw new ApiError('forbidden', 'That sign-in belongs to StitchFlow staff.', { reason: 'platformStaff' });
    }
    // A login with no password yet gets one only if it is this unit's alone.
    const issue = !hasPassword && (await otherUnits(tx, id, propertyId)) === 0;
    return { userId: id, matchedOn, temporaryPassword: issue ? await issueTemporaryPassword(tx, id) : '' };
  }
  const password = temporaryPassword();
  const created = await insertUser(tx, input.displayName.trim(), value, await hashPassword(password));
  return { userId: created, temporaryPassword: password, matchedOn: given[0] };
}

async function insertUser(tx: Tx, displayName: string, value: (k: 'phone' | 'email' | 'username') => string | null,
  hash: string): Promise<number> {
  try {
    const row = await tx.one<{ id: number }>(
      `insert into users (display_name, phone, email, username, password_hash, must_change_password)
       values ($1, $2, $3, $4, $5, true) returning id`,
      [displayName, value('phone'), value('email'), value('username'), hash],
    );
    return row!.id;
  } catch (e) {
    const field = USER_CHECKS[(e as { constraint?: string }).constraint ?? ''];
    if (field) throw invalid({ [field]: 'pattern' }, `That ${field} is not valid.`);
    throw e;
  }
}

const isPlatformStaff = async (tx: Tx, userId: number) =>
  !!(await tx.one(`select 1 from platform_staff where user_id = $1`, [userId]));

/** How many other units the user belongs to (fn_user_memberships sees past row-level security). */
async function otherUnits(tx: Tx, userId: number, propertyId: number): Promise<number> {
  const r = await tx.one<{ n: number }>(
    `select count(*)::int as n from fn_user_memberships($1) where property_id <> $2`, [userId, propertyId]);
  return r!.n;
}

/**
 * A login is one person across every unit, so a unit may only set the
 * password of a login that is its alone. Otherwise anyone who can add users
 * could add another unit's owner (or our own staff) by phone and reset their
 * password. Shared logins are reset by StitchFlow support.
 */
async function assertOwnLogin(tx: Tx, userId: number, propertyId: number): Promise<void> {
  if (await isPlatformStaff(tx, userId) || (await otherUnits(tx, userId, propertyId)) > 0) {
    throw new ApiError('forbidden', 'This sign-in is also used elsewhere; StitchFlow support can reset it.', {
      reason: 'sharedLogin',
    });
  }
}

async function issueTemporaryPassword(tx: Tx, userId: number): Promise<string> {
  const password = temporaryPassword();
  await tx.exec(`update users set password_hash = $2, must_change_password = true where id = $1`,
    [userId, await hashPassword(password)]);
  return password;
}

// ---------------------------------------------------------------------------
// Managing a member
// ---------------------------------------------------------------------------

/** Changes the given modules, within the caller's own levels and the member's ceiling. Returns [before, after]. */
export async function updateAccess(tx: Tx, caller: Caller, memberId: number, modules: Modules) {
  const before = await manageable(tx, caller, memberId, 'users.update_access');
  await checkGrants(tx, caller.memberId, before.role, modules);
  await saveGrants(tx, memberId, caller.memberId, modules);
  return [before, await get(tx, memberId)] as const;
}

/** A temporary password, shown once. The old one stops working, so do its sessions. */
export async function resetPassword(tx: Tx, caller: Caller, memberId: number): Promise<string> {
  const target = await manageable(tx, caller, memberId, 'users.reset_password');
  await assertOwnLogin(tx, target.userId, caller.propertyId);
  const password = await issueTemporaryPassword(tx, target.userId);
  await revokeUserSessions(tx, target.userId, 'passwordReset');
  return password;
}

/** Switches a member's sign-in here off (ending their sessions here) or back on. Returns [before, after]. */
export async function setStatus(tx: Tx, caller: Caller, memberId: number, status: 'active' | 'disabled') {
  const before = await manageable(tx, caller, memberId, 'users.disable');
  await tx.exec(`update property_members set status = $2 where id = $1`, [memberId, status]);
  if (status === 'disabled') await revokeMemberSessions(tx, memberId, 'disabled');
  return [before, await get(tx, memberId)] as const;
}

/**
 * Ends a membership; the user and their audit trail stay (audit rows keep
 * actor_user_id; 0007 clears actor_member_id). References that only say who
 * created or granted something are cleared first. Returns the member as they were.
 */
export async function remove(tx: Tx, caller: Caller, memberId: number): Promise<Member> {
  const before = await manageable(tx, caller, memberId, 'users.remove');
  await revokeMemberSessions(tx, memberId, 'removed');
  await tx.exec(`update property_members set created_by_member_id = null where created_by_member_id = $1`, [memberId]);
  await tx.exec(`update member_module_access set granted_by_member_id = null where granted_by_member_id = $1`, [memberId]);
  await tx.exec(`update files set created_by_member_id = null where created_by_member_id = $1`, [memberId]);
  await tx.exec(`delete from property_members where id = $1`, [memberId]);
  return before;
}

// ---------------------------------------------------------------------------
// The owner's own (the router has already checked the caller is the owner)
// ---------------------------------------------------------------------------

/**
 * Makes a member a super admin, or a super admin an admin. A role change
 * starts from the new role's defaults: grants chosen for the old role would
 * otherwise cap the new one. Returns [before, after].
 */
export async function setSuperAdmin(tx: Tx, memberId: number, superAdmin: boolean) {
  const before = await get(tx, memberId);
  if (before.isOwner) throw cannot('users.manage_super_admins', 'The owner stays a super admin; hand the unit over first.');
  const role: UserRole = superAdmin ? 'superAdmin' : 'admin';
  // Removing super admin from someone who is not one changes nothing.
  if ((before.role === 'superAdmin') === superAdmin) return [before, before] as const;
  await tx.exec(`update property_members set role = $2 where id = $1`, [memberId, role]);
  await tx.exec(`delete from member_module_access where member_id = $1`, [memberId]);
  return [before, await get(tx, memberId)] as const;
}

/** Hands the unit to another active super admin. The old owner stays a super admin. */
export async function transferOwnership(tx: Tx, caller: Caller, toMemberId: number) {
  const target = await get(tx, toMemberId);
  if (target.id === caller.memberId) throw invalid({ toMemberId: 'self' }, 'You already own this unit.');
  if (target.role !== 'superAdmin') throw invalid({ toMemberId: 'notSuperAdmin' }, 'Make them a super admin first.');
  if (target.status !== 'active') throw invalid({ toMemberId: 'disabled' }, 'Switch their sign-in back on first.');
  // One owner per property (property_members_one_owner): clear the old one first.
  await tx.exec(`update property_members set is_owner = false where id = $1`, [caller.memberId]);
  await tx.exec(`update property_members set is_owner = true where id = $1`, [toMemberId]);
  return target;
}
