// Every shape the API sends or receives. Names and fields follow the apps'
// Dart models (packages/sf_core) and the SQL schema (db/migrations), camelCase.
// ModuleKey and ActionKey are not here: they are generated from the SQL
// catalog, so the permission names have one source.

import {
  any, arr, bool, date, doc, enumOf, id, instant, int, map, minuteOfDay, minutes,
  money, month, nul, num, object, opt, optNul, rate, ref, str, uuid,
} from './dsl.mjs';

// --- Enumerations — the Dart enum names, exactly ------------------------------

export const enums = {
  StaffCategory: enumOf(['karigar', 'supervisor', 'designer', 'otherStaff'],
    '`karigar` is shown as Operator.'),
  AttendanceStatus: enumOf(['present', 'halfDay', 'absent']),
  PayMode: enumOf(['cash', 'bank']),
  PayrollStatus: enumOf(['draft', 'approved', 'paid']),
  UserRole: enumOf(['superAdmin', 'admin', 'viewAdmin', 'supervisor', 'worker'],
    'The five fixed roles. `worker` is shown as Operator.'),
  BonusCondition: enumOf(['fullHead', 'headLoss']),
  BonusKind: enumOf(['perThousandSlab', 'fixedSlab', 'flatPlusSlab', 'perFrame']),
  ShiftScheme: enumOf(['dayNight', 'threeShift', 'manual']),
  DeletedKind: enumOf(['machine', 'staff', 'productionEntry', 'upad', 'salaryPayment', 'bonusRule', 'attendance']),
  RestoreProblem: enumOf(['parentDeleted', 'machineNumberTaken', 'periodAlreadyPaid']),
  FilePurpose: enumOf(['machinePhoto', 'staffPhoto', 'slipPhoto']),
  ClientKind: enumOf(['managerApp', 'crewApp', 'webAdmin']),
  AccessLevel: enumOf(['none', 'view', 'edit'], 'none < view < edit.'),
  AccountStatus: enumOf(['active', 'disabled']),
  PropertyStatus: enumOf(['active', 'suspended', 'closed']),
  PlatformRole: enumOf(['admin', 'support']),
  ScanEngine: enumOf(['mlkitLatin', 'server']),
  SlipField: enumOf(['totalStitches', 'designStitches', 'threadBreaks', 'embMinutes', 'stopMinutes',
    'frames', 'designNo', 'designName']),
  AuthFailureReason: enumOf(['noSuchUser', 'wrongPassword', 'tooShort', 'demoPassword']),
  ShiftProblemKind: enumOf(['empty', 'noLength', 'longerThanDay', 'startsOutsideDay', 'totalOverDay',
    'overlap', 'runsPastStart']),
  SlabProblemKind: enumOf(['empty', 'inverted', 'openEndedNotLast', 'overlap', 'gap']),
};

// --- Property, people, access -----------------------------------------------

const Property = object({
  id,
  code: doc(str, 'Short handle, e.g. "janki-creation".'),
  name: str,
  timezone: doc(str, 'IANA zone; "today" is this zone\'s date.'),
  status: ref('PropertyStatus'),
  machineLimit: doc(int, 'Most machines the unit may have. Set from the web admin panel only.'),
  createdAt: instant,
}, 'One customer\'s unit — the tenant.');

const PropertySettings = object({
  businessName: str,
  currencySymbol: str,
  shiftScheme: ref('ShiftScheme'),
  dayStartMinute: minuteOfDay,
  noLeaveBonusAmount: money,
  stitchBasedEnabled: bool,
  stitchBasedRatePerThousand: rate,
  timezone: str,
});

const User = object({
  id,
  displayName: str,
  username: nul(str),
  phone: doc(nul(str), 'E.164, e.g. "+919812345678".'),
  email: nul(str),
  status: ref('AccountStatus'),
  mustChangePassword: bool,
  lastLoginAt: nul(instant),
}, 'A person who can sign in. Never carries a password hash.');

const Membership = object({
  memberId: id,
  propertyId: id,
  propertyCode: str,
  propertyName: str,
  role: ref('UserRole'),
  isOwner: bool,
  status: ref('AccountStatus'),
});

const ModuleAccess = object({
  module: ref('ModuleKey'),
  level: ref('AccessLevel'),
});

const Member = object({
  id,
  userId: id,
  displayName: str,
  role: ref('UserRole'),
  isOwner: doc(bool, 'The property\'s main super admin.'),
  status: ref('AccountStatus'),
  staffId: doc(nul(id), 'The roster row this login is, if any.'),
  modules: arr(ref('ModuleAccess')),
  createdAt: instant,
}, 'A user\'s place in a property.');

const Me = object({
  user: ref('User'),
  member: ref('Member'),
  property: ref('Property'),
  settings: ref('PropertySettings'),
  modules: doc(arr(ref('ModuleAccess')), 'Gate every screen on this list.'),
});

// --- Machines and people ----------------------------------------------------

const Machine = object({
  id,
  number: doc(int, 'The painted number; unique among live machines.'),
  name: nul(str),
  isActive: bool,
  photoFileId: nul(uuid),
  model: nul(str),
  heads: nul(int),
  needles: nul(int),
  location: nul(str),
  serialNo: nul(str),
  createdAt: instant,
  updatedAt: instant,
});

const Staff = object({
  id,
  code: nul(str),
  name: str,
  phone: nul(str),
  category: ref('StaffCategory'),
  subcategory: nul(str),
  monthlySalary: money,
  payDaysPerMonth: doc(int, 'Salary is divided by this for a day rate: 30 in the trade.'),
  cutSalaryForAbsentDays: bool,
  allowHalfDay: bool,
  joinedOn: nul(date),
  leftOn: nul(date),
  isActive: bool,
  notes: nul(str),
  photoFileId: nul(uuid),
  createdAt: instant,
  updatedAt: instant,
}, 'A person on the roster. Carries pay: supervisors never receive this shape.');

const Person = object({
  id,
  name: str,
  code: nul(str),
  category: ref('StaffCategory'),
  photoFileId: nul(uuid),
  isActive: bool,
}, 'A person without pay, for pickers and attendance — what a supervisor may see.');

// --- Shifts -----------------------------------------------------------------

const Shift = object({
  id: doc(id, 'This version.'),
  lineageId: doc(id, 'The shift all its versions belong to; equals id for a first version.'),
  name: str,
  startMinute: minuteOfDay,
  durationMinutes: doc(int, '1–1440.'),
  sortOrder: int,
  effectiveFrom: doc(date, 'Inclusive.'),
  effectiveTo: doc(nul(date), 'Exclusive; null while current.'),
}, 'One version of a shift. Editing opens a new version from a date.');

// --- Production -------------------------------------------------------------

const ProductionEntry = object({
  id,
  machineId: id,
  workDate: date,
  shiftId: doc(id, 'A shift version in effect on workDate.'),
  totalStitches: int,
  embMinutes: minutes,
  stopMinutes: minutes,
  threadBreaks: int,
  frames: int,
  designNo: nul(str),
  designName: nul(str),
  designStitches: nul(int),
  hasHeadLoss: bool,
  isStitchBased: doc(bool, 'Second machine: stitch-based rate, no attendance.'),
  bonusAmount: doc(money, 'The whole machine\'s bonus, split between its operators.'),
  bonusIsManual: bool,
  note: nul(str),
  slipPhotoFileId: nul(uuid),
  createdAt: instant,
  updatedAt: instant,
});

const EntryKarigar = object({
  staff: ref('Person'),
  isHalfDay: bool,
});

const EntryWithKarigars = object({
  entry: ref('ProductionEntry'),
  karigars: arr(ref('EntryKarigar')),
  bonusPerKarigar: money,
});

const MachineDay = object({
  machine: ref('Machine'),
  entry: nul(ref('EntryWithKarigars')),
});

const ProductionTotals = object({
  stitches: int,
  embMinutes: int,
  stopMinutes: int,
  threadBreaks: int,
  frames: int,
  entryCount: int,
  machineCount: int,
  shiftMinutes: int,
  utilisation: doc(nul(num), 'Emb time over shift time, 0–1; null with no shift to measure.'),
  accountedFor: nul(num),
  averagePerEntry: int,
});

const OcrLine = object({
  text: str,
  left: num,
  top: num,
  right: num,
  bottom: num,
}, 'One recognised line of a report photo, with its box in the image.');

const EntryDraft = object({
  machineId: id,
  workDate: date,
  shiftId: id,
  totalStitches: int,
  embMinutes: minutes,
  stopMinutes: minutes,
  threadBreaks: int,
  frames: int,
  designNo: optNul(str),
  designName: optNul(str),
  designStitches: optNul(int),
  hasHeadLoss: bool,
  isStitchBased: bool,
  bonusAmount: doc(money, 'A preview unless bonusIsManual: the server works it out.'),
  bonusIsManual: bool,
  note: optNul(str),
  slipPhotoFileId: optNul(uuid),
  scanId: doc(optNul(id), 'The report scan that filled this slip.'),
  karigars: arr(ref('KarigarOnEntry')),
}, 'What to save for one machine, date and shift. Upserts.');

const KarigarOnEntry = object({ staffId: id, isHalfDay: bool });

const ScanInput = object({
  machineId: id,
  photoFileId: uuid,
  engine: ref('ScanEngine'),
  lines: arr(ref('OcrLine')),
  reading: doc(map(any), '{ field: { value, confidence, source } } as readSlip() produced it.'),
});

// --- Attendance -------------------------------------------------------------

const HajariDay = object({
  date,
  status: doc(nul(ref('AttendanceStatus')), 'Null when unmarked.'),
  fromProduction: doc(bool, 'Credited by running a machine rather than marked by hand.'),
});

const StaffHajari = object({ staff: ref('Person'), day: ref('HajariDay') });

const AttendanceDay = object({
  present: int,
  halfDay: int,
  absent: int,
  unmarked: int,
});

const MarkInput = object({ staffId: id, date, status: ref('AttendanceStatus') });
const MarkManyInput = object({ staffId: id, dates: arr(date), status: ref('AttendanceStatus') });
const MarkAllInput = object({ staffIds: arr(id), date, status: ref('AttendanceStatus') });
const UndoMarkAllInput = object({ staffIds: arr(id), date });
const ClearMonthInput = object({ staffId: id, month });

// --- Advances and pay -------------------------------------------------------

const Advance = object({
  id,
  staffId: id,
  givenOn: date,
  amount: money,
  mode: ref('PayMode'),
  note: nul(str),
  createdAt: instant,
});

const AdvanceInput = object({
  staffId: id,
  givenOn: date,
  amount: doc(money, 'Greater than 0.'),
  mode: ref('PayMode'),
  note: optNul(str),
});

const AdvanceBalance = object({
  owedGoingIn: doc(money, 'Given before the month ends, less what earlier paid payslips recovered.'),
  givenInMonth: money,
});

const SalaryBreakdown = object({
  perDayRate: rate,
  daysWorked: doc(num, 'Half days count 0.5.'),
  baseAmount: money,
  bonusAmount: money,
  noLeaveBonus: money,
  advanceDeducted: money,
  otherDeductions: money,
  netPayable: doc(money, 'Never below zero.'),
  salaryWasCut: bool,
});

const SalaryPayment = object({
  id,
  staffId: id,
  periodStart: doc(date, 'Inclusive; the first of the month.'),
  periodEnd: doc(date, 'Exclusive.'),
  daysWorked: num,
  perDayRate: rate,
  stitchesInPeriod: int,
  baseAmount: money,
  bonusAmount: money,
  noLeaveBonus: money,
  salaryWasCut: bool,
  advanceDeducted: money,
  otherDeductions: money,
  netPayable: money,
  paidAmount: money,
  status: ref('PayrollStatus'),
  paidOn: nul(instant),
  note: nul(str),
}, 'A payslip: a snapshot, so a paid month stays what was paid.');

const PayrollRow = object({
  staff: ref('Staff'),
  breakdown: doc(ref('SalaryBreakdown'), 'From the payslip when paid; worked out now otherwise.'),
  outstandingAdvance: doc(money, 'Owed going into this month.'),
  advanceLeftAfter: money,
  upadThisMonth: money,
  stitches: int,
  payment: nul(ref('SalaryPayment')),
});

const PayslipInput = object({
  staffId: id,
  month,
  otherDeductions: opt(money),
  note: optNul(str),
}, 'Mark a month paid. The server computes the snapshot; it takes no figures from the client.');

// --- Bonus rules ------------------------------------------------------------

const BonusSlab = object({
  id,
  fromStitches: doc(int, 'Inclusive.'),
  toStitches: doc(nul(int), 'Exclusive; null for the open top band.'),
  value: doc(rate, '₹ per 1,000 stitches, or a flat ₹, by the rule\'s kind.'),
});

const BonusRule = object({
  id,
  name: str,
  isActive: bool,
  condition: ref('BonusCondition'),
  kind: ref('BonusKind'),
  flatAmount: money,
  ratePerFrame: rate,
  sortOrder: int,
  slabs: arr(ref('BonusSlab')),
});

const SlabInput = object({ fromStitches: int, toStitches: nul(int), value: rate });

const BonusRuleInput = object({
  name: str,
  isActive: bool,
  condition: ref('BonusCondition'),
  kind: ref('BonusKind'),
  flatAmount: opt(money),
  ratePerFrame: opt(rate),
  sortOrder: opt(int),
  slabs: arr(ref('SlabInput')),
});

const BonusRuleToggle = object({ isActive: bool });

// --- Shift changes ----------------------------------------------------------

const SchemeInput = object({ scheme: ref('ShiftScheme'), dayStartMinute: minuteOfDay });
const ShiftInput = object({ name: str, startMinute: minuteOfDay, durationMinutes: int, sortOrder: opt(int) });
const ShiftPatch = object({
  name: opt(str), startMinute: opt(minuteOfDay), durationMinutes: opt(int), sortOrder: opt(int),
});
const ShiftTiming = object({ id, startMinute: minuteOfDay, durationMinutes: int });
const TimingsInput = object({ shifts: arr(ref('ShiftTiming')) }, 'Smart Adjust: applied together.');
const ShiftSnapshot = object({ id, name: str, startMinute: minuteOfDay, durationMinutes: int });
const RestoreShiftsInput = object({ shifts: arr(ref('ShiftSnapshot')) }, 'Undo to a known-good set.');
const DateResult = object({ date });

const ShiftProblem = object({
  kind: ref('ShiftProblemKind'),
  shift: doc(nul(str), 'A name the unit typed; never translated.'),
  other: nul(str),
});

const SlabProblem = object({
  kind: ref('SlabProblemKind'),
  fromStitches: nul(int),
  toStitches: nul(int),
  nextFromStitches: nul(int),
  nextToStitches: nul(int),
});

// --- Recycle bin ------------------------------------------------------------

const DeletedItem = object({
  kind: ref('DeletedKind'),
  id: doc(id, 'For attendance, the lowest id of the cleared month.'),
  deletedAt: instant,
  expiresAt: instant,
  name: doc(nul(str), 'What the unit called it; never translated.'),
  machineNumber: nul(int),
  category: nul(ref('StaffCategory')),
  code: nul(str),
  date: nul(date),
  shiftName: nul(str),
  stitches: nul(int),
  payMode: nul(ref('PayMode')),
  condition: nul(ref('BonusCondition')),
  bonusKind: nul(ref('BonusKind')),
  amount: nul(money),
  childCount: doc(int, 'Rows that come back with it; for attendance, days.'),
}, 'The facts, not sentences: the client words them in its language.');

// --- Users (property) -------------------------------------------------------

const CreateUserInput = object({
  displayName: str,
  phone: optNul(str),
  email: optNul(str),
  username: optNul(str),
  role: ref('UserRole'),
  modules: doc(opt(map(ref('AccessLevel'), 'ModuleKey')),
    'Selected modules. Each within the creator\'s own level and the role\'s ceiling.'),
  staffId: optNul(id),
});

const CreatedUser = object({
  member: ref('Member'),
  temporaryPassword: doc(str, 'Shown once. Must be changed at first sign-in.'),
});

const AccessPatch = object({ modules: map(ref('AccessLevel'), 'ModuleKey') });
const TemporaryPassword = object({ temporaryPassword: str });
const TransferOwnershipInput = object({ toMemberId: id });

// --- Auth -------------------------------------------------------------------

const LoginInput = object({
  identifier: doc(str, 'Phone (E.164), email or username.'),
  password: str,
  client: ref('ClientKind'),
  keepSignedIn: doc(bool, '15 days instead of 7.'),
});

const LoginResult = object({
  accessToken: doc(str, 'JWT, 15 minutes.'),
  refreshToken: doc(str, 'Opaque. Rotates on every use. Keep it in the platform keystore.'),
  expiresIn: doc(int, 'Seconds.'),
  user: ref('User'),
  memberships: arr(ref('Membership')),
  activeMember: nul(ref('Membership')),
});

const TokenPair = object({ accessToken: str, refreshToken: str, expiresIn: int });
const SelectPropertyInput = object({ memberId: id });
const RefreshInput = object({ refreshToken: str });
const ChangePasswordInput = object({
  current: str,
  next: doc(str, 'At least 8 characters, not the demo password.'),
});

// --- Settings, machines, staff inputs ---------------------------------------

const SettingsPatch = object({
  businessName: opt(str),
  currencySymbol: opt(str),
  noLeaveBonusAmount: opt(money),
  stitchBasedEnabled: opt(bool),
  stitchBasedRatePerThousand: opt(rate),
}, 'The shift arrangement and day start go through /shifts/scheme.');

const ResetDataInput = object({ confirmPropertyCode: str });

const MachineInput = object({ number: int, name: optNul(str) });
const BulkMachinesInput = object({ upTo: doc(int, 'Creates the missing numbers 1..upTo.') });
const BulkCreated = object({ created: int });
const MachineAllowance = object({
  limit: int,
  used: doc(int, 'Every machine not in the recycle bin, active or not.'),
  left: doc(int, 'At 0, adding or restoring a machine is refused: turn "Add machine" off.'),
}, 'How many machines the unit may have, has, and has left.');
const MachinePatch = object({
  number: opt(int), name: optNul(str), isActive: opt(bool), photoFileId: optNul(uuid),
  model: optNul(str), heads: optNul(int), needles: optNul(int), location: optNul(str), serialNo: optNul(str),
}, 'Any subset; null clears.');

const StaffInput = object({
  code: optNul(str),
  name: str,
  phone: optNul(str),
  category: ref('StaffCategory'),
  subcategory: optNul(str),
  monthlySalary: money,
  payDaysPerMonth: opt(int),
  cutSalaryForAbsentDays: opt(bool),
  allowHalfDay: opt(bool),
  joinedOn: optNul(date),
  leftOn: optNul(date),
  isActive: opt(bool),
  notes: optNul(str),
  photoFileId: optNul(uuid),
});

const StaffPatch = object({
  code: optNul(str), name: opt(str), phone: optNul(str), category: opt(ref('StaffCategory')),
  subcategory: optNul(str), monthlySalary: opt(money), payDaysPerMonth: opt(int),
  cutSalaryForAbsentDays: opt(bool), allowHalfDay: opt(bool), joinedOn: optNul(date),
  leftOn: optNul(date), isActive: opt(bool), notes: optNul(str), photoFileId: optNul(uuid),
});

const NextCode = object({ code: str });
const CreatedId = object({ id });

// --- Files, audit, paging, errors -------------------------------------------

const FileRef = object({
  id: uuid,
  purpose: ref('FilePurpose'),
  url: doc(str, 'Short-lived signed URL.'),
  width: nul(int),
  height: nul(int),
});

const AuditEntry = object({
  id,
  occurredAt: instant,
  propertyId: nul(id),
  actorUserId: nul(id),
  actorMemberId: nul(id),
  actorPlatformRole: nul(ref('PlatformRole')),
  action: str,
  entityType: str,
  entityId: nul(str),
  destructive: bool,
  before: nul(any),
  after: nul(any),
  requestId: nul(str),
});

const EntryPage = object({ items: arr(ref('EntryWithKarigars')), nextCursor: nul(str) });
const AuditPage = object({ items: arr(ref('AuditEntry')), nextCursor: nul(str) });

const ApiError = object({
  error: ref('ApiErrorBody'),
});
const ApiErrorBody = object({
  code: ref('ErrorCode'),
  message: doc(str, 'English, for logs. Clients word `code` in the user\'s language.'),
  details: opt(map(any)),
});

// --- Platform console -------------------------------------------------------

const PlatformLoginInput = object({ email: str, password: str });

const OwnerInput = object({ displayName: str, phone: str, email: optNul(str) });
const CreatePropertyInput = object({
  code: str,
  name: str,
  timezone: opt(str),
  machineLimit: doc(int, '0 to 9999.'),
  owner: ref('OwnerInput'),
});
const CreatedProperty = object({
  property: ref('Property'),
  owner: ref('Member'),
  temporaryPassword: doc(str, 'The owner\'s, shown once.'),
});
const PropertyPatch = object({
  name: opt(str), timezone: opt(str), status: opt(ref('PropertyStatus')),
  machineLimit: opt(doc(int, 'Lowering it below the machines the unit has removes nothing; it only stops adding.')),
});

const PropertySummary = object({
  id, code: str, name: str, status: ref('PropertyStatus'), memberCount: int,
  machineLimit: int, machineCount: int, lastActivityAt: nul(instant),
});
const PropertyDetail = object({
  property: ref('Property'),
  settings: ref('PropertySettings'),
  members: arr(ref('Member')),
  machineCount: int,
  staffCount: int,
});
const PlatformUser = object({
  user: ref('User'),
  memberships: arr(ref('Membership')),
  liveSessions: int,
});
const PlatformStaffMember = object({ userId: id, displayName: str, email: nul(str), role: ref('PlatformRole') });
const PlatformStaffInput = object({ displayName: str, email: str, role: ref('PlatformRole') });
const CreatedPlatformStaff = object({
  staff: ref('PlatformStaffMember'),
  temporaryPassword: doc(str, 'Shown once.'),
});

export const objects = {
  Property, PropertySettings, User, Membership, ModuleAccess, Member, Me,
  Machine, Staff, Person, Shift,
  ProductionEntry, EntryKarigar, EntryWithKarigars, MachineDay, ProductionTotals, OcrLine,
  EntryDraft, KarigarOnEntry, ScanInput,
  HajariDay, StaffHajari, AttendanceDay, MarkInput, MarkManyInput, MarkAllInput, UndoMarkAllInput, ClearMonthInput,
  Advance, AdvanceInput, AdvanceBalance, SalaryBreakdown, SalaryPayment, PayrollRow, PayslipInput,
  BonusSlab, BonusRule, SlabInput, BonusRuleInput, BonusRuleToggle,
  SchemeInput, ShiftInput, ShiftPatch, ShiftTiming, TimingsInput, ShiftSnapshot, RestoreShiftsInput, DateResult,
  ShiftProblem, SlabProblem,
  DeletedItem,
  CreateUserInput, CreatedUser, AccessPatch, TemporaryPassword, TransferOwnershipInput,
  LoginInput, LoginResult, TokenPair, SelectPropertyInput, RefreshInput, ChangePasswordInput,
  SettingsPatch, ResetDataInput, MachineInput, BulkMachinesInput, BulkCreated, MachineAllowance, MachinePatch,
  StaffInput, StaffPatch, NextCode, CreatedId,
  FileRef, AuditEntry, EntryPage, AuditPage, ApiError, ApiErrorBody,
  PlatformLoginInput, OwnerInput, CreatePropertyInput, CreatedProperty, PropertyPatch,
  PropertySummary, PropertyDetail, PlatformUser, PlatformStaffMember, PlatformStaffInput, CreatedPlatformStaff,
};
