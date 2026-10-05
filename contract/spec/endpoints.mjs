// Every endpoint: method, path, what it needs, what it takes and returns.
// The single source for openapi.json and for the typed route table.
//
//   action   an actions.key from the SQL catalog — checked with fn_member_can
//   auth     'none' (sign-in itself) | 'session' (any signed-in member)
//   platform 'support' | 'admin' — the web admin panel's endpoints
//   response a schema, or null for 204 No Content

import { arr, bool, date, id, int, map, month, opt, ref, str } from './dsl.mjs';

const e = (method, path, gate, summary, io = {}) => ({ method, path, ...gate, summary, ...io });
const act = (action) => ({ action });
const session = { auth: 'session' };
const none = { auth: 'none' };
const platform = (role) => ({ platform: role });

const monthQ = { month };
const r = ref;

export const endpoints = [
  // --- Auth ---------------------------------------------------------------
  e('POST', '/v1/auth/login', none, 'Sign in with phone, email or username.',
    { body: r('LoginInput'), response: r('LoginResult') }),
  e('POST', '/v1/auth/select-property', session, 'Act in one of the user\'s properties; also the switcher.',
    { body: r('SelectPropertyInput'), response: r('TokenPair') }),
  e('POST', '/v1/auth/refresh', none, 'Rotate the refresh token.',
    { body: r('RefreshInput'), response: r('TokenPair') }),
  e('POST', '/v1/auth/logout', session, 'Revoke this session (?everywhere=true for all).',
    { query: { everywhere: opt(bool) }, body: r('RefreshInput'), response: null }),
  e('POST', '/v1/auth/change-password', session, 'Change one\'s own password; clears mustChangePassword.',
    { body: r('ChangePasswordInput'), response: null }),
  e('GET', '/v1/me', session, 'Who is signed in, where, and with which modules.',
    { response: r('Me') }),

  // --- Settings -----------------------------------------------------------
  e('GET', '/v1/settings', act('settings.view'), 'The unit\'s settings.', { response: r('PropertySettings') }),
  e('PATCH', '/v1/settings', act('settings.update'), 'Change unit settings.',
    { body: r('SettingsPatch'), response: r('PropertySettings') }),
  e('POST', '/v1/settings/reset-data', act('settings.reset_data'), 'Wipe the unit\'s records (owner).',
    { body: r('ResetDataInput'), response: null }),

  // --- Machines -----------------------------------------------------------
  e('GET', '/v1/machines', act('machines.view'), 'Live machines by number.',
    { query: { activeOnly: opt(bool) }, response: arr(r('Machine')) }),
  e('GET', '/v1/machines/allowance', act('machines.view'), 'How many machines the unit may have, has, and has left.',
    { response: r('MachineAllowance') }),
  e('POST', '/v1/machines', act('machines.create'), 'Add a machine, within the machine limit.',
    { body: r('MachineInput'), response: r('Machine') }),
  e('POST', '/v1/machines/bulk', act('machines.create'), 'Create the missing numbers 1..upTo — all of them or, past the limit, none.',
    { body: r('BulkMachinesInput'), response: r('BulkCreated') }),
  e('PATCH', '/v1/machines/:id', act('machines.update'), 'Change a machine.',
    { body: r('MachinePatch'), response: r('Machine') }),
  e('DELETE', '/v1/machines/:id', act('machines.delete'), 'Delete a machine and its live slips (soft).',
    { response: null }),

  // --- Staff --------------------------------------------------------------
  e('GET', '/v1/staff', act('staff.view'), 'The roster.',
    { query: { activeOnly: opt(bool), category: opt(r('StaffCategory')) }, response: arr(r('Staff')) }),
  e('GET', '/v1/staff/next-code', act('staff.create'), 'The next free code.', { response: r('NextCode') }),
  e('GET', '/v1/staff/:id', act('staff.view'), 'One person.', { response: r('Staff') }),
  e('POST', '/v1/staff', act('staff.create'), 'Add a person.', { body: r('StaffInput'), response: r('Staff') }),
  e('PATCH', '/v1/staff/:id', act('staff.update'), 'Change a person.', { body: r('StaffPatch'), response: r('Staff') }),
  e('DELETE', '/v1/staff/:id', act('staff.delete'), 'Delete a person, their advances and payslips (soft).',
    { response: null }),
  e('GET', '/v1/operators', act('production.view'), 'People for the slip\'s picker — no pay.',
    { query: { activeOnly: opt(bool) }, response: arr(r('Person')) }),

  // --- Production ---------------------------------------------------------
  e('GET', '/v1/production/day', act('production.view'), 'Every live, active machine with its entry.',
    { query: { date, shiftId: id }, response: arr(r('MachineDay')) }),
  e('GET', '/v1/production/entry', act('production.view'), 'One machine, date and shift.',
    { query: { machineId: id, date, shiftId: id }, response: r('EntryWithKarigars') }),
  e('PUT', '/v1/production/entry', act('production.record'), 'Save a slip (upsert). The server works out the bonus.',
    { body: r('EntryDraft'), response: r('EntryWithKarigars') }),
  e('DELETE', '/v1/production/entry/:id', act('production.delete'), 'Delete a slip (soft).', { response: null }),
  e('GET', '/v1/production/entries', act('production.view'), 'Slips in a range, paged.',
    { query: { from: date, to: date, shiftId: opt(id), staffId: opt(id), limit: opt(int), cursor: opt(str) },
      response: r('EntryPage') }),
  e('GET', '/v1/production/totals', act('production.view'), 'Totals for a range.',
    { query: { from: date, to: date, shiftId: opt(id) }, response: r('ProductionTotals') }),
  e('GET', '/v1/production/daily-totals', act('production.view'), 'Totals per day with anything recorded.',
    { query: { month, shiftId: opt(id) }, response: map(r('ProductionTotals')) }),
  e('POST', '/v1/production/scans', act('production.scan'), 'Keep what a report photo was read as.',
    { body: r('ScanInput'), response: r('CreatedId') }),

  // --- Attendance ---------------------------------------------------------
  e('GET', '/v1/attendance/day', act('attendance.view'), 'Everyone\'s resolved day.',
    { query: { date, category: opt(r('StaffCategory')) }, response: arr(r('StaffHajari')) }),
  e('GET', '/v1/attendance/daily', act('attendance.view'), 'A month, summarised per day.',
    { query: monthQ, response: map(r('AttendanceDay')) }),
  e('GET', '/v1/staff/:id/attendance', act('attendance.view'), 'One person\'s days in a range.',
    { query: { from: date, to: date }, response: arr(r('HajariDay')) }),
  e('PUT', '/v1/attendance/mark', act('attendance.mark'), 'Mark one day.',
    { body: r('MarkInput'), response: null }),
  e('PUT', '/v1/attendance/marks', act('attendance.mark'), 'Mark many days for one person.',
    { body: r('MarkManyInput'), response: null }),
  e('POST', '/v1/attendance/mark-all', act('attendance.mark'), 'Mark many people on one day.',
    { body: r('MarkAllInput'), response: null }),
  e('DELETE', '/v1/attendance/mark', act('attendance.unmark'), 'A day back to unmarked (not in the bin).',
    { query: { staffId: id, date }, response: null }),
  e('POST', '/v1/attendance/undo-mark-all', act('attendance.unmark'), 'Undo marking the rest present.',
    { body: r('UndoMarkAllInput'), response: null }),
  e('POST', '/v1/attendance/clear-month', act('attendance.clear_month'), 'Clear a month of marks (one bin item).',
    { body: r('ClearMonthInput'), response: null }),

  // --- Advances -----------------------------------------------------------
  e('GET', '/v1/advances', act('advances.view'), 'Advances, by month or person.',
    { query: { month: opt(month), staffId: opt(id) }, response: arr(r('Advance')) }),
  e('GET', '/v1/staff/:id/advance-balance', act('advances.view'), 'Owed going into a month (or now).',
    { query: { month: opt(month) }, response: r('AdvanceBalance') }),
  e('POST', '/v1/advances', act('advances.record'), 'Record an advance.',
    { body: r('AdvanceInput'), response: r('Advance') }),
  e('DELETE', '/v1/advances/:id', act('advances.delete'), 'Delete an advance (soft).', { response: null }),

  // --- Payroll ------------------------------------------------------------
  e('GET', '/v1/payroll/preview', act('payroll.view'), 'A month\'s pay, one row per active person.',
    { query: monthQ, response: arr(r('PayrollRow')) }),
  e('GET', '/v1/payroll/payslips', act('payroll.view'), 'Payslips by person or year.',
    { query: { staffId: opt(id), year: opt(int) }, response: arr(r('SalaryPayment')) }),
  e('POST', '/v1/payroll/payslips', act('payroll.mark_paid'), 'Mark a month paid; returns the existing payslip if already paid.',
    { body: r('PayslipInput'), response: r('SalaryPayment') }),
  e('DELETE', '/v1/payroll/payslips/:id', act('payroll.delete_payslip'), 'Delete a payslip (soft).',
    { response: null }),

  // --- Bonus rules --------------------------------------------------------
  e('GET', '/v1/bonus-rules', act('bonus_rules.view'), 'Rules with ladders, in matching order.',
    { response: arr(r('BonusRule')) }),
  e('GET', '/v1/bonus-rules/:id', act('bonus_rules.view'), 'One rule.', { response: r('BonusRule') }),
  e('POST', '/v1/bonus-rules', act('bonus_rules.save'), 'Add a rule.',
    { body: r('BonusRuleInput'), response: r('BonusRule') }),
  e('PUT', '/v1/bonus-rules/:id', act('bonus_rules.save'), 'Replace a rule and its ladder.',
    { body: r('BonusRuleInput'), response: r('BonusRule') }),
  e('PATCH', '/v1/bonus-rules/:id', act('bonus_rules.save'), 'Switch a rule on or off.',
    { body: r('BonusRuleToggle'), response: r('BonusRule') }),
  e('DELETE', '/v1/bonus-rules/:id', act('bonus_rules.delete'), 'Delete a rule (soft).', { response: null }),

  // --- Shifts -------------------------------------------------------------
  e('GET', '/v1/shifts', act('shifts.view'), 'Versions in effect on a date.',
    { query: { on: date }, response: arr(r('Shift')) }),
  e('GET', '/v1/shifts/current', act('shifts.view'), 'Today\'s set.', { response: arr(r('Shift')) }),
  e('GET', '/v1/shifts/editable', act('shifts.view'), 'The set Settings edits.', { response: arr(r('Shift')) }),
  e('GET', '/v1/shifts/earliest-effective-date', act('shifts.view'), 'When a change to these shifts can start.',
    { query: { shiftIds: arr(id) }, response: r('DateResult') }),
  e('GET', '/v1/shifts/:id', act('shifts.view'), 'Any version, retired ones included.', { response: r('Shift') }),
  e('PUT', '/v1/shifts/scheme', act('shifts.change'), 'Switch arrangement and day start.',
    { body: r('SchemeInput'), response: arr(r('Shift')) }),
  e('POST', '/v1/shifts', act('shifts.change'), 'Add a shift.', { body: r('ShiftInput'), response: r('Shift') }),
  e('PATCH', '/v1/shifts/:id', act('shifts.change'), 'Open a new version.', { body: r('ShiftPatch'), response: r('Shift') }),
  e('POST', '/v1/shifts/:id/retire', act('shifts.change'), 'Take a shift out of the cycle.', { response: null }),
  e('PUT', '/v1/shifts/timings', act('shifts.change'), 'Smart Adjust.', { body: r('TimingsInput'), response: arr(r('Shift')) }),
  e('PUT', '/v1/shifts/restore', act('shifts.change'), 'Undo to a known-good set.',
    { body: r('RestoreShiftsInput'), response: arr(r('Shift')) }),

  // --- Recycle bin --------------------------------------------------------
  e('GET', '/v1/recycle-bin', act('recycle_bin.view'), 'Everything deleted in the last seven days.',
    { response: arr(r('DeletedItem')) }),
  e('POST', '/v1/recycle-bin/:kind/:id/restore', act('recycle_bin.restore'), 'Restore an item and what went with it.',
    { response: null }),
  e('DELETE', '/v1/recycle-bin/:kind/:id', act('recycle_bin.delete_forever'), 'Delete an item for good.',
    { response: null }),
  e('DELETE', '/v1/recycle-bin', act('recycle_bin.empty'), 'Empty the bin.', { response: null }),

  // --- Users (property) ---------------------------------------------------
  e('GET', '/v1/users', act('users.view'), 'Who can sign in to this unit.', { response: arr(r('Member')) }),
  e('POST', '/v1/users', act('users.create'), 'Add a user with selected modules.',
    { body: r('CreateUserInput'), response: r('CreatedUser') }),
  e('PATCH', '/v1/users/:memberId/access', act('users.update_access'), 'Change a user\'s modules.',
    { body: r('AccessPatch'), response: r('Member') }),
  e('POST', '/v1/users/:memberId/reset-password', act('users.reset_password'), 'Set a temporary password.',
    { response: r('TemporaryPassword') }),
  e('POST', '/v1/users/:memberId/disable', act('users.disable'), 'Switch a user\'s sign-in off.', { response: r('Member') }),
  e('POST', '/v1/users/:memberId/enable', act('users.disable'), 'Switch it back on.', { response: r('Member') }),
  e('DELETE', '/v1/users/:memberId', act('users.remove'), 'Remove a user from the unit.', { response: null }),
  e('POST', '/v1/users/:memberId/super-admin', act('users.manage_super_admins'), 'Make a super admin (owner).',
    { response: r('Member') }),
  e('DELETE', '/v1/users/:memberId/super-admin', act('users.manage_super_admins'), 'Remove a super admin (owner).',
    { response: r('Member') }),
  e('POST', '/v1/users/transfer-ownership', act('users.transfer_ownership'), 'Hand the unit to another super admin (owner).',
    { body: r('TransferOwnershipInput'), response: null }),

  // --- Files --------------------------------------------------------------
  e('POST', '/v1/files', session, 'Upload a photo (multipart: purpose, file). Checked against what it is for.',
    { body: 'multipart', response: r('FileRef') }),
  e('GET', '/v1/files/:fileId', session, 'Redirects to a short-lived signed URL.', { response: 'redirect' }),

  // --- Live updates (phase 2) ---------------------------------------------
  e('GET', '/v1/events', session, 'Server-sent change notices for this property.', { response: 'sse' }),

  // --- Platform console ---------------------------------------------------
  e('POST', '/v1/platform/auth/login', { auth: 'none', platformLogin: true }, 'Platform staff sign-in.',
    { body: r('PlatformLoginInput'), response: r('TokenPair') }),
  e('POST', '/v1/platform/auth/totp/setup', platform('support'),
    'Start two-factor sign-in: a new secret for an authenticator app. Not on until enabled with a code.',
    { response: r('TotpSetup') }),
  e('POST', '/v1/platform/auth/totp/enable', platform('support'), 'Turn two-factor sign-in on with a code from the app.',
    { body: r('TotpCodeInput'), response: null }),
  e('POST', '/v1/platform/auth/totp/disable', platform('support'), 'Turn one\'s own two-factor sign-in off, with a current code.',
    { body: r('TotpCodeInput'), response: null }),
  e('GET', '/v1/platform/properties', platform('support'), 'Search properties.',
    { query: { query: opt(str), status: opt(r('PropertyStatus')) }, response: arr(r('PropertySummary')) }),
  e('POST', '/v1/platform/properties', platform('admin'), 'Create a property and its owner.',
    { body: r('CreatePropertyInput'), response: r('CreatedProperty') }),
  e('GET', '/v1/platform/properties/:id', platform('support'), 'One property.', { response: r('PropertyDetail') }),
  e('PATCH', '/v1/platform/properties/:id', platform('admin'), 'Rename, change zone, set the machine limit, suspend or reactivate.',
    { body: r('PropertyPatch'), response: r('Property') }),
  e('POST', '/v1/platform/properties/:id/transfer-ownership', platform('admin'), 'Move ownership for an owner who has left.',
    { body: r('TransferOwnershipInput'), response: null }),
  e('GET', '/v1/platform/users', platform('support'), 'Find a user by phone, email, username or name.',
    { query: { query: str }, response: arr(r('PlatformUser')) }),
  e('GET', '/v1/platform/users/:id', platform('support'), 'One user\'s memberships and sessions.',
    { response: r('PlatformUser') }),
  e('POST', '/v1/platform/users/:id/reset-password', platform('support'), 'Set a temporary password.',
    { response: r('TemporaryPassword') }),
  e('POST', '/v1/platform/users/:id/disable', platform('admin'), 'Switch a user off everywhere.', { response: r('User') }),
  e('POST', '/v1/platform/users/:id/enable', platform('admin'), 'Switch them back on.', { response: r('User') }),
  e('DELETE', '/v1/platform/users/:id/sessions', platform('support'), 'Sign a user out everywhere.', { response: null }),
  e('GET', '/v1/platform/audit', platform('support'), 'The audit log, paged.',
    { query: { propertyId: opt(id), actorUserId: opt(id), from: opt(date), to: opt(date), destructive: opt(bool),
      limit: opt(int), cursor: opt(str) }, response: r('AuditPage') }),
  e('GET', '/v1/platform/staff', platform('admin'), 'Our console users.', { response: arr(r('PlatformStaffMember')) }),
  e('POST', '/v1/platform/staff', platform('admin'), 'Add a console user.',
    { body: r('PlatformStaffInput'), response: r('CreatedPlatformStaff') }),
  e('DELETE', '/v1/platform/staff/:id', platform('admin'), 'Remove a console user.', { response: null }),
  e('DELETE', '/v1/platform/staff/:id/totp', platform('admin'),
    'Turn off a console user\'s two-factor sign-in, e.g. after a lost phone.', { response: null }),
];

// Path parameters that are not numeric ids.
export const pathParamTypes = {
  kind: ref('DeletedKind'),
  fileId: { kind: 'string', format: 'uuid' },
};
