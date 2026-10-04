// Every error code the API returns, with its HTTP status and what it means.
// Clients word the code (and its details) in the user's language; the
// English message in the response is for logs.

export const errors = [
  ['validation_failed', 400, 'The body or query is malformed. details.fields names each bad field.'],
  ['unauthenticated', 401, 'No token, a bad token, or wrong credentials. details.reason: noSuchUser | wrongPassword on sign-in.'],
  ['token_expired', 401, 'The access token has expired: refresh and retry.'],
  ['forbidden', 403, 'The member lacks the action. details.action names it.'],
  ['super_admin_only', 403, 'The action is destructive.'],
  ['owner_only', 403, 'The action belongs to the property\'s main super admin.'],
  ['password_change_required', 403, 'A temporary password must be changed first.'],
  ['property_suspended', 403, 'The property is not active.'],
  ['not_found', 404, 'Not in this property, or not at all.'],
  ['machine_number_taken', 409, 'details.number.'],
  ['machine_limit_reached', 409, 'No machine places left: details.limit, details.used (and details.requested on /machines/bulk). Adding or restoring a machine.'],
  ['staff_code_taken', 409, 'details.code.'],
  ['period_already_paid', 409, 'A live payslip exists for that person and month.'],
  ['restore_blocked', 409, 'details.problem: a RestoreProblem; details.name / details.number for parentDeleted.'],
  ['shift_cycle_clash', 409, 'details.problems: ShiftProblem[].'],
  ['slab_ladder_invalid', 409, 'details.problems: SlabProblem[].'],
  ['grant_exceeds_granter', 409, 'More access than the granter has, or than the role\'s ceiling.'],
  ['file_too_large', 413, 'Over 15 MB.'],
  ['rate_limited', 429, 'Too many attempts; details.retryAfter seconds.'],
];
