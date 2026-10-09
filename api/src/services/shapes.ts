// SQL select lists for shapes several services return, so a User or a
// Member looks the same from every endpoint. Each is a fragment for
// `select <fragment> from <table> <alias>`.

import type { Me, Member, Property, PropertySettings, User } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';

/** From users u. */
export const USER_COLUMNS = `
  u.id, u.display_name as "displayName", u.username::text as username, u.phone,
  u.email::text as email, u.status, u.must_change_password as "mustChangePassword",
  u.last_login_at as "lastLoginAt"`;

/**
 * From property_members m join users u. Module levels for every module, disabled members included.
 * Carries the login (username, phone, email) so an app can sign in as the member without asking
 * for it; never the password hash.
 */
export const MEMBER_COLUMNS = `
  m.id, m.user_id as "userId", u.display_name as "displayName",
  u.username, u.phone, u.email, m.role, m.is_owner as "isOwner",
  m.status, m.staff_id as "staffId", m.created_at as "createdAt",
  (select json_agg(json_build_object('module', mo.key, 'level', fn_member_level(m.id, mo.key))
                   order by mo.sort_order)
   from modules mo) as modules`;

/** From properties p. */
export const PROPERTY_COLUMNS = `
  p.id, p.code::text as code, p.name, p.timezone, p.status, p.machine_limit as "machineLimit",
  p.created_at as "createdAt"`;

/** From property_settings s join properties p. */
export const SETTINGS_COLUMNS = `
  s.business_name as "businessName", s.currency_symbol as "currencySymbol",
  s.shift_scheme as "shiftScheme", s.day_start_minute as "dayStartMinute",
  s.no_leave_bonus_amount as "noLeaveBonusAmount", s.stitch_based_enabled as "stitchBasedEnabled",
  s.stitch_based_rate_per_thousand as "stitchBasedRatePerThousand", p.timezone`;

export async function getMember(tx: Tx, memberId: number): Promise<Member | undefined> {
  return tx.one<Member>(
    `select ${MEMBER_COLUMNS} from property_members m join users u on u.id = m.user_id where m.id = $1`,
    [memberId],
  );
}

export async function getUser(tx: Tx, userId: number): Promise<User | undefined> {
  return tx.one<User>(`select ${USER_COLUMNS} from users u where u.id = $1`, [userId]);
}

export async function getProperty(tx: Tx, propertyId: number): Promise<Property | undefined> {
  return tx.one<Property>(`select ${PROPERTY_COLUMNS} from properties p where p.id = $1`, [propertyId]);
}

export async function getSettings(tx: Tx, propertyId: number): Promise<PropertySettings | undefined> {
  return tx.one<PropertySettings>(
    `select ${SETTINGS_COLUMNS} from property_settings s join properties p on p.id = s.property_id
     where s.property_id = $1`,
    [propertyId],
  );
}

// Inside row_to_json the type parsers do not apply: ids and money are already JSON
// numbers, but an instant is text like 2026-01-01T10:00:00.5+00:00. Normalise to
// the "…Z" form PARSERS gives everywhere else.
const iso = (v: unknown) => (typeof v === 'string' ? new Date(v).toISOString() : v);

/** Pay-rate settings are null unless $2 (the member) may see settings or pay. */
const SEES_RATES = `(fn_member_can($2, 'settings.view') or fn_member_can($2, 'payroll.view'))`;
const MASKED_SETTINGS_COLUMNS = SETTINGS_COLUMNS
  .replace('s.no_leave_bonus_amount as', `case when ${SEES_RATES} then s.no_leave_bonus_amount end as`)
  .replace('s.stitch_based_rate_per_thousand as', `case when ${SEES_RATES} then s.stitch_based_rate_per_thousand end as`);

/** GET /v1/me in one statement: user, member, property and settings. */
export async function getMe(tx: Tx, userId: number, memberId: number, propertyId: number): Promise<Me> {
  const r = (await tx.one<{ user: any; member: any; property: any; settings: any }>(
    `select
       (select row_to_json(t) from (select ${USER_COLUMNS} from users u where u.id = $1) t) as "user",
       (select row_to_json(t) from (select ${MEMBER_COLUMNS} from property_members m
          join users u on u.id = m.user_id where m.id = $2) t) as member,
       (select row_to_json(t) from (select ${PROPERTY_COLUMNS} from properties p where p.id = $3) t) as property,
       (select row_to_json(t) from (select ${MASKED_SETTINGS_COLUMNS} from property_settings s
          join properties p on p.id = s.property_id where s.property_id = $3) t) as settings`,
    [userId, memberId, propertyId],
  ))!;
  r.user.lastLoginAt = iso(r.user.lastLoginAt);
  r.member.createdAt = iso(r.member.createdAt);
  r.property.createdAt = iso(r.property.createdAt);
  return { user: r.user, member: r.member, property: r.property, settings: r.settings, modules: r.member.modules };
}

/** From staff s: a person with pay. Supervisors never receive this shape. */
export const STAFF_COLUMNS = `
  s.id, s.code, s.name, s.phone, s.category, s.subcategory, s.monthly_salary as "monthlySalary",
  s.pay_days_per_month as "payDaysPerMonth", s.cut_salary_for_absent_days as "cutSalaryForAbsentDays",
  s.allow_half_day as "allowHalfDay", s.joined_on as "joinedOn", s.left_on as "leftOn",
  s.is_active as "isActive", s.notes, s.photo_file_id as "photoFileId",
  s.created_at as "createdAt", s.updated_at as "updatedAt"`;

/** From staff s: a person without pay, for pickers, slips and attendance. */
export const PERSON_COLUMNS = `
  s.id, s.name, s.code, s.category, s.photo_file_id as "photoFileId", s.is_active as "isActive",
  s.allow_half_day as "allowHalfDay"`;

/** PERSON_COLUMNS as one JSON object, for nesting (e.g. a slip's operators). */
export const PERSON_JSON = `json_build_object(
  'id', s.id, 'name', s.name, 'code', s.code, 'category', s.category,
  'photoFileId', s.photo_file_id, 'isActive', s.is_active, 'allowHalfDay', s.allow_half_day)`;
