// Bonus rules and their stitch ladders (API.md §3 Bonus rules). The ladder
// is checked before it is written so the editor gets every problem at once;
// the database's exclusion constraint (bonus_slabs_no_overlap) stays behind
// it as the last word on overlaps.

import type { BonusRule, BonusRuleInput, SlabInput } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError, invalid, notFound } from '../http/errors.ts';
import type { Member } from '../http/types.ts';
import { validateSlabs } from '../domain/bonus.ts';

/** From bonus_rules r, with its ladder by fromStitches. */
const RULE_COLUMNS = `
  r.id, r.name, r.is_active as "isActive", r.condition, r.kind, r.flat_amount as "flatAmount",
  r.rate_per_frame as "ratePerFrame", r.sort_order as "sortOrder",
  coalesce((select json_agg(json_build_object(
              'id', s.id, 'fromStitches', s.from_stitches, 'toStitches', s.to_stitches, 'value', s.value)
            order by s.from_stitches)
            from bonus_slabs s where s.rule_id = r.id), '[]'::json) as slabs`;

/** Live rules in matching order: the first active match by sort order pays. */
export function list(tx: Tx): Promise<BonusRule[]> {
  return tx.rows<BonusRule>(
    `select ${RULE_COLUMNS} from bonus_rules r where r.deleted_at is null order by r.sort_order, r.id`);
}

export async function get(tx: Tx, id: number): Promise<BonusRule> {
  const r = await tx.one<BonusRule>(
    `select ${RULE_COLUMNS} from bonus_rules r where r.id = $1 and r.deleted_at is null`, [id]);
  if (!r) throw notFound('No such bonus rule.');
  return r;
}

/** The ladder to store: none for a per-frame rule, which never reads one (as the app's editor saves it). */
function checkedSlabs(input: BonusRuleInput): SlabInput[] {
  if (input.kind === 'perFrame') return [];
  const problems = validateSlabs(input.slabs);
  if (problems.length) throw new ApiError('slab_ladder_invalid', 'The stitch ladder has problems.', { problems });
  return input.slabs;
}

function checkedName(input: BonusRuleInput): string {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw invalid({ name: 'length' }, 'A rule name is 1 to 60 characters.');
  return name;
}

async function writeSlabs(tx: Tx, member: Member, ruleId: number, slabs: SlabInput[]): Promise<void> {
  await tx.exec(`delete from bonus_slabs where rule_id = $1`, [ruleId]);
  if (!slabs.length) return;
  await tx.exec(
    `insert into bonus_slabs (property_id, rule_id, from_stitches, to_stitches, value)
     select $1, $2, f, t, v from unnest($3::bigint[], $4::bigint[], $5::numeric[]) as x(f, t, v)`,
    [member.propertyId, ruleId, slabs.map((s) => s.fromStitches), slabs.map((s) => s.toStitches),
      slabs.map((s) => s.value)],
  );
}

export async function create(tx: Tx, member: Member, input: BonusRuleInput): Promise<BonusRule> {
  const name = checkedName(input);
  const slabs = checkedSlabs(input);
  const row = await tx.one<{ id: number }>(
    `insert into bonus_rules (property_id, name, is_active, condition, kind, flat_amount, rate_per_frame,
                              sort_order, created_by_member_id, updated_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) returning id`,
    [member.propertyId, name, input.isActive, input.condition, input.kind, input.flatAmount ?? 0,
      input.ratePerFrame ?? 0, input.sortOrder ?? 0, member.memberId],
  );
  await writeSlabs(tx, member, row!.id, slabs);
  return get(tx, row!.id);
}

/**
 * Replaces the rule and its whole ladder: editing bands in place would leave
 * orphans whenever one is removed. A sortOrder left out keeps the rule's place.
 */
export async function replace(tx: Tx, member: Member, id: number, input: BonusRuleInput): Promise<BonusRule> {
  const name = checkedName(input);
  const slabs = checkedSlabs(input);
  const touched = await tx.exec(
    `update bonus_rules set name = $2, is_active = $3, condition = $4, kind = $5, flat_amount = $6,
       rate_per_frame = $7, sort_order = coalesce($8, sort_order), updated_by_member_id = $9
     where id = $1 and deleted_at is null`,
    [id, name, input.isActive, input.condition, input.kind, input.flatAmount ?? 0, input.ratePerFrame ?? 0,
      input.sortOrder ?? null, member.memberId],
  );
  if (!touched) throw notFound('No such bonus rule.');
  await writeSlabs(tx, member, id, slabs);
  return get(tx, id);
}

export async function setActive(tx: Tx, member: Member, id: number, isActive: boolean): Promise<BonusRule> {
  const touched = await tx.exec(
    `update bonus_rules set is_active = $2, updated_by_member_id = $3 where id = $1 and deleted_at is null`,
    [id, isActive, member.memberId],
  );
  if (!touched) throw notFound('No such bonus rule.');
  return get(tx, id);
}

/** Soft delete; the ladder stays with the rule for a restore. Returns the rule as it was. */
export async function remove(tx: Tx, member: Member, id: number): Promise<BonusRule> {
  const before = await get(tx, id);
  await tx.exec(
    `update bonus_rules set deleted_at = now(), deleted_by_member_id = $2, deleted_batch = gen_random_uuid()
     where id = $1 and deleted_at is null`,
    [id, member.memberId],
  );
  return before;
}
