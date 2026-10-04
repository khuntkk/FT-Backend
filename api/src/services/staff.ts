// The roster (API.md §3 Staff). A Staff carries pay, so only members with
// the staff module see it; the operator picker gets a Person instead.
//
// A code is unique among live people (index staff_live_code); a code freed
// by a deleted person may be used again.

import { roundMoney, type NextCode, type Person, type Staff, type StaffCategory, type StaffInput, type StaffPatch }
  from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError, notFound, onConstraint } from '../http/errors.ts';
import type { Member } from '../http/types.ts';
import { PERSON_COLUMNS, STAFF_COLUMNS } from './shapes.ts';

/** Live people by name, as the app's lists show them. */
export function list(tx: Tx, activeOnly = false, category: StaffCategory | null = null): Promise<Staff[]> {
  return tx.rows<Staff>(
    `select ${STAFF_COLUMNS} from staff s
     where s.deleted_at is null and ($1::boolean is false or s.is_active)
       and ($2::text is null or s.category = $2)
     order by s.name, s.id`,
    [activeOnly, category],
  );
}

/** The same people without pay, for the slip's operator picker. */
export function operators(tx: Tx, activeOnly = false): Promise<Person[]> {
  return tx.rows<Person>(
    `select ${PERSON_COLUMNS} from staff s
     where s.deleted_at is null and ($1::boolean is false or s.is_active)
     order by s.name, s.id`,
    [activeOnly],
  );
}

export async function get(tx: Tx, id: number): Promise<Staff> {
  const s = await tx.one<Staff>(
    `select ${STAFF_COLUMNS} from staff s where s.id = $1 and s.deleted_at is null`, [id]);
  if (!s) throw notFound('No such person.');
  return s;
}

/**
 * One past the highest all-digit code among live people, padded to three:
 * "006" after "005". Codes that are not all digits are passed over, as the
 * app's nextCode does. Counted as text so a long code cannot lose digits.
 */
export async function nextCode(tx: Tx): Promise<NextCode> {
  const row = await tx.one<{ next: string }>(
    `select (coalesce(max(s.code::numeric), 0) + 1)::text as next from staff s
     where s.deleted_at is null and s.code ~ '^[0-9]+$'`,
  );
  return { code: row!.next.padStart(3, '0') };
}

const COLUMNS: Record<string, string> = {
  code: 'code', name: 'name', phone: 'phone', category: 'category', subcategory: 'subcategory',
  monthlySalary: 'monthly_salary', payDaysPerMonth: 'pay_days_per_month',
  cutSalaryForAbsentDays: 'cut_salary_for_absent_days', allowHalfDay: 'allow_half_day',
  joinedOn: 'joined_on', leftOn: 'left_on', isActive: 'is_active', notes: 'notes', photoFileId: 'photo_file_id',
};

/** The present fields, cleaned the way the app's form cleans them: trimmed, a blank code or phone is none. */
function fields(input: StaffInput | StaffPatch): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (!(key in input)) continue;
    let v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string' && (key === 'code' || key === 'phone' || key === 'name')) v = v.trim();
    if (v === '' && (key === 'code' || key === 'phone')) v = null;
    if (key === 'monthlySalary') v = roundMoney(v as number);
    out.push([column, v]);
  }
  return out;
}

const codeOf = (f: [string, unknown][]) => f.find(([c]) => c === 'code')?.[1] as string | undefined;

const codeTaken = (code: string | undefined) => () =>
  new ApiError('staff_code_taken', `Staff code ${code} is already in use.`, { code });

export async function create(tx: Tx, member: Member, input: StaffInput): Promise<Staff> {
  const f = fields(input);
  const columns = ['property_id', 'created_by_member_id', 'updated_by_member_id', ...f.map(([c]) => c)];
  const values = [member.propertyId, member.memberId, member.memberId, ...f.map(([, v]) => v)];
  const row = await onConstraint(tx.one<{ id: number }>(
    `insert into staff (${columns.join(', ')})
     values (${values.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    values,
  ), 'staff_live_code', codeTaken(codeOf(f)));
  return get(tx, row!.id);
}

export async function update(tx: Tx, member: Member, id: number, patch: StaffPatch): Promise<Staff> {
  const f = fields(patch);
  const values: unknown[] = [id, member.memberId, ...f.map(([, v]) => v)];
  const sets = [...f.map(([c], i) => `${c} = $${i + 3}`), 'updated_by_member_id = $2'];
  const touched = await onConstraint(tx.exec(
    `update staff set ${sets.join(', ')} where id = $1 and deleted_at is null`,
    values,
  ), 'staff_live_code', codeTaken(codeOf(f)));
  if (!touched) throw notFound('No such person.');
  return get(tx, id);
}

/**
 * Soft delete; their live advances and payslips go into the bin in the same
 * batch. Slips they ran are left alone: the work still happened. Returns the
 * person as they were.
 */
export async function remove(tx: Tx, member: Member, id: number): Promise<Staff> {
  const before = await get(tx, id);
  const batch = await tx.one<{ batch: string }>(
    `update staff set deleted_at = now(), deleted_by_member_id = $2, deleted_batch = gen_random_uuid()
     where id = $1 and deleted_at is null returning deleted_batch as batch`,
    [id, member.memberId],
  );
  for (const table of ['advances', 'salary_payments']) {
    await tx.exec(
      `update ${table} set deleted_at = now(), deleted_by_member_id = $2, deleted_batch = $3
       where staff_id = $1 and deleted_at is null`,
      [id, member.memberId, batch!.batch],
    );
  }
  return before;
}
