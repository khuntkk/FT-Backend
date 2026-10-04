// Advances — upad (API.md §3 Advances).
//
// What a person still owes is never stored: fn_advance_outstanding works it
// out from the advances and the paid payslips each time, so deleting or
// restoring either puts the balance right by itself (HANDOVER §7).

import type { Advance, AdvanceBalance, AdvanceInput, Month } from '@stitchflow/contract';
import { monthRange, roundMoney, todayIn } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { invalid, notFound } from '../http/errors.ts';
import type { Member } from '../http/types.ts';

/** From advances a. */
const ADVANCE_COLUMNS = `
  a.id, a.staff_id as "staffId", a.given_on as "givenOn", a.amount, a.mode, a.note,
  a.created_at as "createdAt"`;

/** Live advances, newest first, by month and/or person. */
export function list(tx: Tx, filter: { month?: Month; staffId?: number }): Promise<Advance[]> {
  const range = filter.month ? monthRange(filter.month) : null;
  return tx.rows<Advance>(
    `select ${ADVANCE_COLUMNS} from advances a
     where a.deleted_at is null
       and ($1::bigint is null or a.staff_id = $1)
       and ($2::date is null or (a.given_on >= $2 and a.given_on < $3))
     order by a.given_on desc, a.id desc`,
    [filter.staffId ?? null, range?.start ?? null, range?.end ?? null],
  );
}

export async function get(tx: Tx, id: number): Promise<Advance> {
  const a = await tx.one<Advance>(`select ${ADVANCE_COLUMNS} from advances a where a.id = $1 and a.deleted_at is null`, [id]);
  if (!a) throw notFound('No such advance.');
  return a;
}

async function requirePerson(tx: Tx, staffId: number): Promise<void> {
  const s = await tx.one(`select 1 from staff where id = $1 and deleted_at is null`, [staffId]);
  if (!s) throw notFound('No such person.');
}

/**
 * Owed going into a month (given before it ends, less what earlier paid
 * payslips recovered) and what was handed out during it. With no month:
 * owed now, after every payslip, and what was given this month.
 */
export async function balance(tx: Tx, member: Member, staffId: number, month?: Month): Promise<AdvanceBalance> {
  await requirePerson(tx, staffId);
  const range = monthRange(month ?? todayIn(member.timezone).slice(0, 7));
  const row = await tx.one<AdvanceBalance>(
    `select fn_advance_outstanding($1, $2::date, $3::date) as "owedGoingIn",
            coalesce((select sum(a.amount) from advances a
                      where a.staff_id = $1 and a.deleted_at is null
                        and a.given_on >= $4 and a.given_on < $5), 0)::numeric(12,2) as "givenInMonth"`,
    [staffId, month ? range.start : null, month ? range.end : null, range.start, range.end],
  );
  return row!;
}

export async function create(tx: Tx, member: Member, input: AdvanceInput): Promise<Advance> {
  const amount = roundMoney(input.amount);
  if (!(amount > 0)) throw invalid({ amount: 'positive' }, 'An advance is more than zero.');
  await requirePerson(tx, input.staffId);
  const row = await tx.one<{ id: number }>(
    `insert into advances (property_id, staff_id, given_on, amount, mode, note, created_by_member_id, updated_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
    [member.propertyId, input.staffId, input.givenOn, amount, input.mode, input.note ?? null, member.memberId],
  );
  return get(tx, row!.id);
}

/**
 * Soft delete, into the bin on its own. Returns the advance as it was.
 * No batch: a batch marks a child deleted with its person, and
 * vw_recycle_bin hides a batched advance whose person is not deleted.
 */
export async function remove(tx: Tx, member: Member, id: number): Promise<Advance> {
  const before = await get(tx, id);
  await tx.exec(
    `update advances set deleted_at = now(), deleted_by_member_id = $2, updated_by_member_id = $2
     where id = $1 and deleted_at is null`,
    [id, member.memberId],
  );
  return before;
}
