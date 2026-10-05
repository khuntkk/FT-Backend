# StitchFlow API — contract v1

The contract between the apps (manager app, Crew app), the web admin panel,
and the API. It is derived from the repository interfaces the apps already
code against — `packages/sf_core/lib/src/repositories/repositories.dart` in
the apps repo — so that filling in the remote repositories is mapping, not
redesign. Where an endpoint differs from the name in
`api/remote_repositories.dart`, this document wins and the stub is updated.

Every endpoint lists the **action** it needs (`actions.key` in
`db/migrations/0003_access_catalog.sql`). The API checks it with
`fn_member_can(memberId, action)` before doing anything; a destructive
action is super admin only whatever the module level.

---

## 1. Conventions

| Thing | Rule |
| --- | --- |
| Base path | `/v1`. The platform console's endpoints are under `/v1/platform`. |
| Format | JSON, `camelCase` keys. `Content-Type: application/json` except file upload. |
| Auth | `Authorization: Bearer <accessToken>`. The token names the user and the property membership it acts in; no endpoint takes a property id. |
| Ids | JSON numbers (Postgres `bigint`; safely below 2^53). Files are UUID strings. |
| Dates | `"YYYY-MM-DD"` for anything without a time: work dates, pay periods, a shift's effective dates, when an advance was given. **Never** an instant at local midnight. |
| Instants | ISO-8601 in UTC with `Z`: `"2026-09-27T09:30:00Z"`. |
| Money | JSON numbers, two decimals, already rounded to the paisa by the server. Rates may carry four. |
| Minutes | Integers: `startMinute` (0–1439), `durationMinutes`, `embMinutes`, `stopMinutes`. |
| Enums | The Dart enum's name, exactly: `karigar`, `otherStaff`, `halfDay`, `superAdmin`, `perThousandSlab` … |
| Months | `month=YYYY-MM` in queries. |
| Lists | A bare array unless the list can grow without bound (slips over time, the audit log): those take `?limit=` (default 100, max 500) and `?cursor=` and return `{ "items": [...], "nextCursor": "..." }`. |
| Idempotency | `POST` endpoints that create accept `Idempotency-Key: <uuid>`; a repeat within 24 h returns the first response. The apps send one per user action, so a retried request on a bad connection cannot record twice. |
| Time zone | "Today" is the property's own date (`fn_property_today`), never the server's. |

### Errors

```json
{ "error": { "code": "machine_number_taken", "message": "Machine 3 already exists.", "details": { "number": 3 } } }
```

`message` is English, for logs. The apps word `code` (+ `details`) in the user's language — the same way they word `RestoreException` and `AuthFailure` today.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `validation_failed` | Body or query is malformed. `details.fields` names each bad field. |
| 401 | `unauthenticated` | No token, bad token. |
| 401 | `token_expired` | Access token past its 15 minutes: refresh and retry. |
| 403 | `forbidden` | The member lacks the action. `details.action` names it. |
| 403 | `super_admin_only` | The action is destructive. |
| 403 | `owner_only` | The action belongs to the property's main super admin. |
| 403 | `password_change_required` | Every endpoint except `/v1/auth/*` and `/v1/me` while `mustChangePassword` is set. |
| 403 | `property_suspended` | The property is not active. |
| 404 | `not_found` | Not in this property (or not at all — the two are not distinguished). |
| 409 | `machine_number_taken` | `details.number`. |
| 409 | `machine_limit_reached` | No machine places left: `details.limit`, `details.used`, and `details.requested` on `/machines/bulk`. From adding a machine, or restoring one from the bin. The database raises it as constraint `machine_limit`. |
| 409 | `staff_code_taken` | `details.code`. |
| 409 | `period_already_paid` | A live payslip exists for that person and month. |
| 409 | `restore_blocked` | `details.problem`: `parentDeleted` (with `details.name` / `details.number`), `machineNumberTaken`, `periodAlreadyPaid` — the `RestoreProblem` values. |
| 409 | `shift_cycle_clash` | `details.problems`: `ShiftProblem`s. |
| 409 | `slab_ladder_invalid` | `details.problems`: `SlabProblem`s. |
| 409 | `grant_exceeds_granter` | Giving a sub user more than the granter has, or more than the role's ceiling. |
| 413 | `file_too_large` | Over 15 MB. |
| 429 | `rate_limited` | Sign-in attempts, mostly. |

---

## 2. Auth — `/v1/auth`

Access tokens are JWTs, 15 minutes, claims `sub` (user id), `mid` (member id),
`pid` (property id), `role`, `client`. Refresh tokens are opaque, 256-bit,
stored hashed in `auth_sessions`, valid 7 days — 15 with `keepSignedIn` —
and **rotated on every use**; presenting an already-rotated token revokes its
whole family. The apps keep the refresh token in the platform keystore
(`flutter_secure_storage`), never in shared preferences.

| Method | Path | Body → Response |
| --- | --- | --- |
| POST | `/auth/login` | `{ identifier, password, client: "managerApp"\|"crewApp", keepSignedIn }` — identifier is a phone (E.164), email or username. → `{ accessToken, refreshToken, expiresIn, user, memberships: [Membership], activeMember: Membership\|null }`. With exactly one active membership it is chosen; otherwise the app shows a picker and calls `select-property`. Wrong identifier and wrong password give the same `401` (`unauthenticated`), but `details.reason` carries `noSuchUser` / `wrongPassword` for the apps' existing messages. Rate-limited per identifier and per IP. |
| POST | `/auth/select-property` | `{ memberId }` → new token pair bound to that membership. Also the property switcher. |
| POST | `/auth/refresh` | `{ refreshToken }` → new pair. |
| POST | `/auth/logout` | `{ refreshToken }` → 204. Revokes that session. `?everywhere=true` revokes all the user's sessions. |
| POST | `/auth/change-password` | `{ current, next }` → 204. `next` ≥ 8 chars and not the demo password (`AuthFailure.tooShort` / `demoPassword`). Clears `mustChangePassword`. |
| GET | `/me` | → `{ user, member, property, settings, modules: [{ module, level }] }` — `modules` straight from `vw_member_access`. The apps gate every screen on this list instead of the three getters they use today. |

`Membership` = `{ memberId, propertyId, propertyCode, propertyName, role, isOwner, status }` (`fn_user_memberships`).

---

## 3. Property data — the apps

All scoped to the token's property. Each row: method, path, action, notes.

### Settings
| | | | |
| --- | --- | --- | --- |
| GET | `/settings` | `settings.view` | `businessName, currencySymbol, shiftScheme, dayStartMinute, noLeaveBonusAmount, stitchBasedEnabled, stitchBasedRatePerThousand, timezone`. Every member can read what they need to render; the action gates the settings screen. |
| PATCH | `/settings` | `settings.update` | Any subset. `shiftScheme` and `dayStartMinute` go through `/shifts/scheme` instead (schedule changes are destructive). |
| POST | `/settings/reset-data` | `settings.reset_data` (owner) | `{ confirmPropertyCode }`. Wipes records, keeps members, shifts and rules — what the app's Reset does today. Audited. |

### Machines
| | | | |
| --- | --- | --- | --- |
| GET | `/machines?activeOnly=` | `machines.view` | Live machines, by number. |
| GET | `/machines/allowance` | `machines.view` | `{ limit, used, left }` from `vw_machine_allowance`. `used` counts every machine not in the bin, active or not. At `left = 0` the apps turn "Add machine" off. |
| POST | `/machines` | `machines.create` | `{ number, name? }` → machine. `409 machine_number_taken`; `409 machine_limit_reached`. |
| POST | `/machines/bulk` | `machines.create` | `{ upTo }` → `{ created }`. Creates the missing numbers 1..upTo; a number in the bin does not count as taken. All or nothing: if the missing numbers need more places than are left, nothing is created and the answer is `409 machine_limit_reached` with `details.requested`. |
| PATCH | `/machines/:id` | `machines.update` | Any of `number, name, isActive, photoFileId, model, heads, needles, location, serialNo`; `null` clears. |
| DELETE | `/machines/:id` | `machines.delete` ⚠ | Soft delete; the machine's live slips go in the same batch. |

### Staff (the roster)
| | | | |
| --- | --- | --- | --- |
| GET | `/staff?activeOnly=&category=` | `staff.view` | Carries salaries. |
| GET | `/staff/:id` | `staff.view` | |
| GET | `/staff/next-code` | `staff.create` | `{ code: "006" }`. The code is also unique per property among live people (`409 staff_code_taken`). |
| POST | `/staff` | `staff.create` | → person. |
| PATCH | `/staff/:id` | `staff.update` | Includes `isActive`, pay rules, `photoFileId`. |
| DELETE | `/staff/:id` | `staff.delete` ⚠ | Soft delete; their advances and payslips go in the same batch. Slips they ran are untouched. |
| GET | `/operators` | `production.view` | For the slip's operator picker: `id, name, code, category, photoFileId, isActive` — **no pay**, so a supervisor can pick operators without seeing salaries. |

### Production
| | | | |
| --- | --- | --- | --- |
| GET | `/production/day?date=&shiftId=` | `production.view` | Every live, active machine with its entry (or null) — `MachineDay[]`. |
| GET | `/production/entry?machineId=&date=&shiftId=` | `production.view` | `EntryWithKarigars` or 404. |
| PUT | `/production/entry` | `production.record` | An `EntryDraft` (below). Upsert on machine + date + shift; an entry in the bin for that slot is brought back and overwritten. The server works out the bonus itself unless `bonusIsManual`, using the property's rules and settings — the app's figure is a preview. Optional `scanId` links a report scan. |
| DELETE | `/production/entry/:id` | `production.delete` ⚠ | Soft delete. |
| GET | `/production/entries?from=&to=&shiftId=&staffId=` | `production.view` | Paged. |
| GET | `/production/totals?from=&to=&shiftId=` | `production.view` | `ProductionTotals`. |
| GET | `/production/daily-totals?month=&shiftId=` | `production.view` | `{ "2026-09-10": ProductionTotals, … }` — days with nothing recorded are absent. |
| POST | `/production/scans` | `production.scan` | `{ machineId, photoFileId, engine: "mlkitLatin", lines: [OcrLine], reading: {…} }` → `{ id }`. Kept for tuning the reader against real machine screens. |

`EntryDraft` = `{ machineId, workDate, shiftId, totalStitches, embMinutes, stopMinutes, threadBreaks, frames, designNo?, designName?, designStitches?, hasHeadLoss, isStitchBased, bonusAmount, bonusIsManual, note?, slipPhotoFileId?, scanId?, karigars: [{ staffId, isHalfDay }] }`.
Validation: only `karigar`-category staff on `karigars`; `embMinutes + stopMinutes` ≤ the shift version's `durationMinutes`; `shiftId` must be a version in effect on `workDate`.

### Attendance
| | | | |
| --- | --- | --- | --- |
| GET | `/attendance/day?date=&category=` | `attendance.view` | Every active person with their resolved day (`vw_attendance_days`; unmarked is `status: null`). |
| GET | `/attendance/daily?month=` | `attendance.view` | `{ date: AttendanceDay }` for the calendar. |
| GET | `/staff/:id/attendance?from=&to=` | `attendance.view` | `HajariDay[]`, every date in range. A worker may read only their own (`member.staffId`). |
| PUT | `/attendance/mark` | `attendance.mark` | `{ staffId, date, status }`. Revives a cleared row. |
| PUT | `/attendance/marks` | `attendance.mark` | `{ staffId, dates: [], status }` — fill a month. |
| POST | `/attendance/mark-all` | `attendance.mark` | `{ staffIds: [], date, status }` — mark the rest present. |
| DELETE | `/attendance/mark?staffId=&date=` | `attendance.unmark` | A day back to unmarked. Soft, not in the bin. |
| POST | `/attendance/undo-mark-all` | `attendance.unmark` | `{ staffIds, date }`. |
| POST | `/attendance/clear-month` | `attendance.clear_month` ⚠ | `{ staffId, month }`. One batch; one item in the bin. |

### Advances
| | | | |
| --- | --- | --- | --- |
| GET | `/advances?month=&staffId=` | `advances.view` | |
| GET | `/staff/:id/advance-balance?month=` | `advances.view` | `{ owedGoingIn, givenInMonth }` — `fn_advance_outstanding`. No `month`: owed now. |
| POST | `/advances` | `advances.record` | `{ staffId, givenOn, amount, mode, note? }`. `amount` > 0. |
| DELETE | `/advances/:id` | `advances.delete` ⚠ | |

### Payroll
| | | | |
| --- | --- | --- | --- |
| GET | `/payroll/preview?month=` | `payroll.view` | One `PayrollRow` per active person, computed on the server from `fn_payroll_inputs` + the salary rules. A paid month comes back from its payslip, never recomputed. Replaces the app's four-calls-per-person preview. |
| GET | `/payroll/payslips?staffId=&year=` | `payroll.view` | |
| POST | `/payroll/payslips` | `payroll.mark_paid` | `{ staffId, month, otherDeductions?, note? }`. **The server computes the snapshot** from what is recorded at that moment; it does not take figures from the app. Returns the existing payslip if the month is already paid (and `Idempotency-Key` covers the retry). |
| DELETE | `/payroll/payslips/:id` | `payroll.delete_payslip` ⚠ | The advance it recovered is owed again, automatically. |

`PayrollRow` = `{ staff, breakdown: { perDayRate, daysWorked, baseAmount, bonusAmount, noLeaveBonus, advanceDeducted, otherDeductions, netPayable, salaryWasCut }, outstandingAdvance, advanceLeftAfter, upadThisMonth, stitches, payment: SalaryPayment|null }`.

### Bonus rules
| | | | |
| --- | --- | --- | --- |
| GET | `/bonus-rules` | `bonus_rules.view` | With ladders, in matching order. |
| GET | `/bonus-rules/:id` | `bonus_rules.view` | |
| POST | `/bonus-rules` | `bonus_rules.save` | Rule + `slabs: [{ fromStitches, toStitches?, value }]`. `409 slab_ladder_invalid`. |
| PUT | `/bonus-rules/:id` | `bonus_rules.save` | Replaces the rule and its whole ladder. |
| PATCH | `/bonus-rules/:id` | `bonus_rules.save` | `{ isActive }`. |
| DELETE | `/bonus-rules/:id` | `bonus_rules.delete` ⚠ | |

### Shifts — every change is a schedule change ⚠
| | | | |
| --- | --- | --- | --- |
| GET | `/shifts?on=` | `shifts.view` | The versions in effect on a date, in running order. |
| GET | `/shifts/current` | `shifts.view` | Today's set (property's today). |
| GET | `/shifts/editable` | `shifts.view` | The set Settings shows: tomorrow's once a change is waiting. |
| GET | `/shifts/:id` | `shifts.view` | Any version, retired ones included. |
| GET | `/shifts/earliest-effective-date?shiftIds=` | `shifts.view` | `{ date }`: after the last slip (bin included) on those shifts, never before a pending change. |
| PUT | `/shifts/scheme` | `shifts.change` ⚠ | `{ scheme, dayStartMinute }`. |
| POST | `/shifts` | `shifts.change` ⚠ | `{ name, startMinute, durationMinutes, sortOrder? }`. |
| PATCH | `/shifts/:id` | `shifts.change` ⚠ | Opens a version. `409 shift_cycle_clash` if the resulting set would overlap. |
| POST | `/shifts/:id/retire` | `shifts.change` ⚠ | |
| PUT | `/shifts/timings` | `shifts.change` ⚠ | Smart Adjust: `{ shifts: [{ id, startMinute, durationMinutes }] }`, applied together. |
| PUT | `/shifts/restore` | `shifts.change` ⚠ | Undo: `{ shifts: [{ id, name, startMinute, durationMinutes }] }`. |

The versioning rules are the ones `LocalShiftRepository` implements and its tests pin; port both.

### Recycle bin
| | | | |
| --- | --- | --- | --- |
| GET | `/recycle-bin` | `recycle_bin.view` | `DeletedItem[]` from `vw_recycle_bin`. |
| POST | `/recycle-bin/:kind/:id/restore` | `recycle_bin.restore` | `409 restore_blocked` with the problem. A machine with no place left: `409 machine_limit_reached`. |
| DELETE | `/recycle-bin/:kind/:id` | `recycle_bin.delete_forever` ⚠ | A person who ran machines is kept out of sight, not removed. |
| DELETE | `/recycle-bin` | `recycle_bin.empty` ⚠ | Each item as delete-forever would take it. |

Purging items past seven days is a **scheduled job** (daily), not an endpoint and not the apps' job any more.

### Users — the property's own logins
| | | | |
| --- | --- | --- | --- |
| GET | `/users` | `users.view` | Members with role, status, `isOwner`, `staffId` and module levels. Never a password hash. |
| POST | `/users` | `users.create` | `{ displayName, phone?, email?, username?, role, modules?: { module: level }, staffId? }` → the member and a **temporary password, shown once**. `fn_member_can_create` for the role; `fn_can_grant` for each module (`409 grant_exceeds_granter`). An existing user (same phone) is added as a member instead of created twice. |
| PATCH | `/users/:memberId/access` | `users.update_access` | `{ modules }`. Only members the caller may manage. |
| POST | `/users/:memberId/reset-password` | `users.reset_password` | → a temporary password, shown once. Sets `mustChangePassword`. |
| POST | `/users/:memberId/disable` · `/enable` | `users.disable` | Revokes their sessions on disable. The owner cannot be disabled here. |
| DELETE | `/users/:memberId` | `users.remove` ⚠ | Ends the membership; the user and their audit trail stay. |
| POST | `/users/:memberId/super-admin` · DELETE same | `users.manage_super_admins` (owner) | Make or remove a super admin. |
| POST | `/users/transfer-ownership` | `users.transfer_ownership` (owner) | `{ toMemberId }` — must already be a super admin. |

### Files
| | | | |
| --- | --- | --- | --- |
| POST | `/files` | the action of whatever the file is for (`machines.update`, `staff.update`, `production.record`) | `multipart/form-data`: `purpose` (`machinePhoto`/`staffPhoto`/`slipPhoto`), `file`. JPEG/PNG/WebP ≤ 15 MB. → `{ id, url, width, height }`. |
| GET | `/files/:id` | view on the owning module | `302` to a short-lived signed URL. |

### Live updates (phase 2)
`GET /v1/events` — Server-Sent Events: `{ "table": "production_entries", "ids": [...] }` after each write in the property, so the apps refresh the stream that shows it instead of polling. Until then the apps refetch after their own writes and on resume.

---

## 4. Platform console — `/v1/platform` (web admin panel)

Signed in as platform staff (`platform_staff`), client `webAdmin`, through
the `stitchflow_platform` database role. Every call that changes something
is written to `audit_log` with `actor_platform_role`. `support` may read and
reset passwords; everything else needs `admin`.

| Method | Path | Who | |
| --- | --- | --- | --- |
| POST | `/platform/auth/login` | staff | `{ email, password, totpCode? }`. Once a staff member has two-factor sign-in on, `totpCode` is required: without it `401 unauthenticated` with `details.reason: totpRequired`, a wrong or reused one `wrongTotp`. |
| POST | `/platform/auth/totp/setup` | staff (self) | → `{ secret, otpauthUrl }` for an authenticator app (TOTP: SHA-1, 30 s, 6 digits). Not on until enabled. |
| POST | `/platform/auth/totp/enable` | staff (self) | `{ code }` from the app → 204. Sign-in needs a code from now on. |
| POST | `/platform/auth/totp/disable` | staff (self) | `{ code }` → 204. |
| DELETE | `/platform/staff/:id/totp` | admin | Turns another staff member's two-factor sign-in off (lost phone). Not one's own. |
| GET | `/platform/properties?query=&status=` | support | Search by name or code. Each with `machineCount` and `machineLimit`. |
| POST | `/platform/properties` | admin | `{ code, name, timezone, machineLimit, owner: { displayName, phone, email? } }` → creates the property, its settings, the default shift arrangement, and the owner (a new user, or an existing one by phone) as its main super admin. Returns the owner's temporary password once. |
| GET | `/platform/properties/:id` | support | Details, members, counts, last activity. |
| PATCH | `/platform/properties/:id` | admin | `{ name, timezone, status, machineLimit }`: suspend or reactivate, or change the machine limit. Suspending revokes the property's sessions. A limit below the unit's machines removes nothing; it only stops more being added. |
| POST | `/platform/properties/:id/transfer-ownership` | admin | `{ toMemberId }` — for an owner who has left. |
| GET | `/platform/users?query=` | support | By phone, email, username or name. |
| GET | `/platform/users/:id` | support | Memberships, sessions, last login. |
| POST | `/platform/users/:id/reset-password` | support | Temporary password, shown once. |
| POST | `/platform/users/:id/disable` · `/enable` | admin | Across every property. |
| DELETE | `/platform/users/:id/sessions` | support | Sign out everywhere. |
| GET | `/platform/audit?propertyId=&actorUserId=&from=&to=&destructive=` | support | Paged. |
| GET / POST / DELETE | `/platform/staff` | admin | Our own console users, each with `totpEnabled`. |

The console never shows a property's pay figures or slips; support reads
structure (who, which role, when), not the unit's business. A read-only
"see what they see" view is a later, separate decision.
