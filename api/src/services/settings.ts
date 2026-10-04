// The unit's settings and its Reset (API.md §3 Settings). The shift
// arrangement and day start are schedule changes and go through
// /shifts/scheme, which is super admin only.

import { roundMoney, type PropertySettings, type SettingsPatch } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { invalid } from '../http/errors.ts';
import type { Member } from '../http/types.ts';
import { getSettings } from './shapes.ts';

export async function get(tx: Tx, propertyId: number): Promise<PropertySettings> {
  return (await getSettings(tx, propertyId))!;
}

const PATCHABLE: Record<string, string> = {
  businessName: 'business_name', currencySymbol: 'currency_symbol',
  noLeaveBonusAmount: 'no_leave_bonus_amount', stitchBasedEnabled: 'stitch_based_enabled',
  stitchBasedRatePerThousand: 'stitch_based_rate_per_thousand',
};

// The contract's schema does not forbid extra keys, so these would be
// dropped silently; refusing them tells the app it used the wrong route.
const SCHEDULE_KEYS = ['shiftScheme', 'dayStartMinute'];

export async function update(tx: Tx, propertyId: number, patch: SettingsPatch): Promise<PropertySettings> {
  const misplaced = SCHEDULE_KEYS.filter((k) => k in patch);
  if (misplaced.length) {
    throw invalid(Object.fromEntries(misplaced.map((k) => [k, 'useShiftsScheme'])),
      'The shift arrangement and day start change through PUT /v1/shifts/scheme.');
  }
  const sets: string[] = [];
  const values: unknown[] = [propertyId];
  for (const [key, column] of Object.entries(PATCHABLE)) {
    if (!(key in patch)) continue;
    let v = (patch as Record<string, unknown>)[key];
    if (key === 'noLeaveBonusAmount') v = roundMoney(v as number);
    values.push(v);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length) {
    await tx.exec(`update property_settings set ${sets.join(', ')} where property_id = $1`, values);
  }
  return get(tx, propertyId);
}

/**
 * What Reset removes, in an order the foreign keys allow: a slip's operators
 * before the slip, slips before the machines and people they name (both
 * restrict), and a person's marks, advances and payslips before them. Rows in
 * the bin go too. Members, shifts, bonus rules and settings stay — they are
 * how the unit is set up, not what it recorded — as the app's clearRecords.
 * A member linked to a removed person keeps their login (staff_id set null).
 */
const RECORD_TABLES = [
  ['entryKarigars', 'entry_karigars'],
  ['slipScans', 'slip_scans'],
  ['productionEntries', 'production_entries'],
  ['attendanceMarks', 'attendance_marks'],
  ['advances', 'advances'],
  ['salaryPayments', 'salary_payments'],
  ['machines', 'machines'],
  ['staff', 'staff'],
] as const;

export type ResetCounts = Record<(typeof RECORD_TABLES)[number][0], number>;

/** Hard-deletes the unit's records once the caller has typed the property's code. Returns what went. */
export async function resetData(tx: Tx, member: Member, confirmPropertyCode: string): Promise<ResetCounts> {
  // Property codes are citext: compared without case, as the database does.
  if (confirmPropertyCode.trim().toLowerCase() !== member.propertyCode.toLowerCase()) {
    throw invalid({ confirmPropertyCode: 'mismatch' }, 'Type the unit\'s code to confirm.');
  }
  const counts = {} as ResetCounts;
  for (const [key, table] of RECORD_TABLES) {
    // Row-level security already limits this to the property; a wipe names
    // it as well, so it could never reach further.
    counts[key] = await tx.exec(`delete from ${table} where property_id = $1`, [member.propertyId]);
  }
  return counts;
}

export const RESET_TABLES = RECORD_TABLES.map(([, table]) => table);
