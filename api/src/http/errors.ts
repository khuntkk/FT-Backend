// Errors, handled once at the boundary.
//
// Services throw ApiError with a contract code; the database's own refusals
// (a taken machine number, the machine limit, an overlapping slab) are mapped
// here from the constraint that raised them, so a rule the database holds
// never needs repeating in code to get the right answer to the apps.

import { ERROR_STATUS, type ErrorCode } from '@stitchflow/contract';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const notFound = (what = 'Not found.') => new ApiError('not_found', what);
export const invalid = (fields: Record<string, string>, message = 'Invalid request.') =>
  new ApiError('validation_failed', message, { fields });

/**
 * Runs a statement, turning a violation of one constraint into the given
 * error. Postgres leaves the offending value out of the message for a role
 * under row-level security, so the caller, who knows it, supplies it.
 */
export async function onConstraint<T>(work: Promise<T>, constraint: string, error: () => ApiError): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (isPgError(e) && e.constraint === constraint) throw error();
    throw e;
  }
}

/** Sends an error without throwing, so the transaction still commits (e.g. a revocation). */
export function errorBody(e: ApiError) {
  return { error: { code: e.code, message: e.message, ...(e.details && { details: e.details }) } };
}

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}

const isPgError = (e: unknown): e is PgError =>
  typeof e === 'object' && e !== null && typeof (e as PgError).code === 'string' &&
  /^[0-9A-Z]{5}$/.test((e as PgError).code!);

/** A key's value from a unique-violation detail: Key (property_id, number)=(1, 3) already exists. */
function keyValue(detail: string | undefined, column: string): string | undefined {
  const m = /Key \(([^)]*)\)=\(([^)]*)\)/.exec(detail ?? '');
  if (!m) return undefined;
  const cols = m[1].split(',').map((s) => s.trim());
  const vals = m[2].split(',').map((s) => s.trim());
  return vals[cols.indexOf(column)];
}

/** A database error as the contract's answer, or null if it is a bug. */
export function fromDatabase(e: unknown): ApiError | null {
  if (!isPgError(e)) return null;
  switch (e.constraint) {
    case 'machines_live_number': {
      const n = keyValue(e.detail, 'number');
      return new ApiError('machine_number_taken', 'That machine number is taken.', n ? { number: Number(n) } : undefined);
    }
    case 'machine_limit': {
      let detail: Record<string, unknown> = {};
      try { detail = JSON.parse(e.detail ?? '{}'); } catch { /* keep empty */ }
      return new ApiError('machine_limit_reached', 'No machine places left.', detail);
    }
    case 'staff_live_code':
      return new ApiError('staff_code_taken', 'That staff code is taken.',
        keyValue(e.detail, 'code') ? { code: keyValue(e.detail, 'code') } : undefined);
    case 'salary_payments_live_period':
      return new ApiError('period_already_paid', 'That month is already paid.');
    case 'bonus_slabs_no_overlap':
      return new ApiError('slab_ladder_invalid', 'Bands overlap.', { problems: [{ kind: 'overlap' }] });
    case 'shifts_one_version_per_day':
      return new ApiError('shift_cycle_clash', 'Two versions of one shift on a day.', { problems: [] });
  }
  switch (e.code) {
    case '23505': // unique_violation
    case '23514': // check_violation
    case '23502': // not_null_violation
    case '23P01': // exclusion_violation
    case '22001': // string too long
    case '22003': // number out of range
    case '22007': // bad date
    case '22008': // date out of range
    case '22P02': // bad text representation
      return new ApiError('validation_failed', e.message, { constraint: e.constraint ?? null });
    case '23503': // foreign key: a reference to something not in this property
      return new ApiError('not_found', 'A referenced record does not exist.', { constraint: e.constraint ?? null });
  }
  return null;
}
