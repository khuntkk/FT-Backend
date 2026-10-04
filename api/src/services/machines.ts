// Machines (API.md §3 Machines). The machine limit is the database's
// (trigger machines_within_limit, 0005); a refusal arrives as constraint
// `machine_limit` and errors.ts maps it to 409 machine_limit_reached.

import type {
  BulkCreated, Machine, MachineAllowance, MachineInput, MachinePatch,
} from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError, notFound, onConstraint } from '../http/errors.ts';
import type { Member } from '../http/types.ts';

/** From machines m. */
export const MACHINE_COLUMNS = `
  m.id, m.number, m.name, m.is_active as "isActive", m.photo_file_id as "photoFileId",
  m.model, m.heads, m.needles, m.location, m.serial_no as "serialNo",
  m.created_at as "createdAt", m.updated_at as "updatedAt"`;

export function list(tx: Tx, activeOnly = false): Promise<Machine[]> {
  return tx.rows<Machine>(
    `select ${MACHINE_COLUMNS} from machines m
     where m.deleted_at is null and ($1::boolean is false or m.is_active)
     order by m.number`,
    [activeOnly],
  );
}

export async function get(tx: Tx, id: number): Promise<Machine> {
  const m = await tx.one<Machine>(
    `select ${MACHINE_COLUMNS} from machines m where m.id = $1 and m.deleted_at is null`, [id]);
  if (!m) throw notFound('No such machine.');
  return m;
}

export async function allowance(tx: Tx, propertyId: number): Promise<MachineAllowance> {
  const a = await tx.one<MachineAllowance>(
    `select machine_limit as "limit", machines_used as used, machines_left as "left"
     from vw_machine_allowance where property_id = $1`,
    [propertyId],
  );
  return a!;
}

const numberTaken = (number: number) => () =>
  new ApiError('machine_number_taken', `Machine ${number} already exists.`, { number });

export async function create(tx: Tx, member: Member, input: MachineInput): Promise<Machine> {
  const row = await onConstraint(tx.one<{ id: number }>(
    `insert into machines (property_id, number, name, created_by_member_id, updated_by_member_id)
     values ($1, $2, $3, $4, $4) returning id`,
    [member.propertyId, input.number, input.name ?? null, member.memberId],
  ), 'machines_live_number', numberTaken(input.number));
  return get(tx, row!.id);
}

/** Creates the missing numbers 1..upTo — all of them, or none if they do not fit. */
export async function createUpTo(tx: Tx, member: Member, upTo: number): Promise<BulkCreated> {
  if (!Number.isInteger(upTo) || upTo < 1 || upTo > 9999) {
    throw new ApiError('validation_failed', 'upTo is 1 to 9999.', { fields: { upTo: 'range' } });
  }
  // Take the same per-property lock the limit trigger takes, so the count
  // below cannot change before the inserts.
  await tx.exec(`select pg_advisory_xact_lock(hashtextextended('machine_limit:' || $1, 0))`, [member.propertyId]);
  const missing = await tx.rows<{ n: number }>(
    `select n from generate_series(1, $1::int) n
     where not exists (select 1 from machines m where m.number = n and m.deleted_at is null)
     order by n`,
    [upTo],
  );
  if (!missing.length) return { created: 0 };
  const a = await allowance(tx, member.propertyId);
  if (missing.length > a.left) {
    throw new ApiError('machine_limit_reached', 'Not enough machine places left.', {
      limit: a.limit, used: a.used, requested: missing.length,
    });
  }
  const created = await tx.exec(
    `insert into machines (property_id, number, created_by_member_id, updated_by_member_id)
     select $1, n, $2, $2 from unnest($3::int[]) n`,
    [member.propertyId, member.memberId, missing.map((r) => r.n)],
  );
  return { created };
}

const PATCHABLE: Record<string, string> = {
  number: 'number', name: 'name', isActive: 'is_active', photoFileId: 'photo_file_id', model: 'model',
  heads: 'heads', needles: 'needles', location: 'location', serialNo: 'serial_no',
};

export async function update(tx: Tx, member: Member, id: number, patch: MachinePatch): Promise<Machine> {
  const sets: string[] = [];
  const values: unknown[] = [id, member.memberId];
  for (const [key, column] of Object.entries(PATCHABLE)) {
    if (!(key in patch)) continue;
    values.push((patch as Record<string, unknown>)[key]);
    sets.push(`${column} = $${values.length}`);
  }
  const touched = await onConstraint(tx.exec(
    `update machines set ${[...sets, 'updated_by_member_id = $2'].join(', ')}
     where id = $1 and deleted_at is null`,
    values,
  ), 'machines_live_number', numberTaken(patch.number!));
  if (!touched) throw notFound('No such machine.');
  return get(tx, id);
}

/** Soft delete; the machine's live slips go into the bin in the same batch. Returns the machine as it was. */
export async function remove(tx: Tx, member: Member, id: number): Promise<Machine> {
  const before = await get(tx, id);
  const batch = await tx.one<{ batch: string }>(
    `update machines set deleted_at = now(), deleted_by_member_id = $2, deleted_batch = gen_random_uuid()
     where id = $1 and deleted_at is null returning deleted_batch as batch`,
    [id, member.memberId],
  );
  await tx.exec(
    `update production_entries set deleted_at = now(), deleted_by_member_id = $2, deleted_batch = $3
     where machine_id = $1 and deleted_at is null`,
    [id, member.memberId, batch!.batch],
  );
  return before;
}
