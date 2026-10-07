# StitchFlow backend — handover

For whoever picks up this repo next. It is meant to be enough on its own: you
should not need the Flutter repo or the web panel's repo open to work here.
Setup steps are in the [README](../README.md); the endpoint contract is
[`API.md`](API.md). This file is the rest: what StitchFlow is, how the three
repos fit, the rules that are easy to break, where things stand, and what is
still open.

Written 6 October 2026, against contract 1.3.0 and migrations 0001–0009.
Updated 7 October 2026: the API is hosted (§7).
Updated 8 October 2026: contract 1.4.0 — a `Member` carries the login
(`username`, `phone`, `email`), so the manager app can switch accounts
without asking which phone someone uses.

---

## 1. What StitchFlow is

Software for an embroidery unit: its machines, its people, what each machine
produced each shift, attendance, advances and salary. The unit pays on
**attendance (hajari)**, not on stitches — stitches earn a production bonus
only. That one fact shapes most of the model.

Trade words, kept in the code and the schema:

| Word | Means |
| --- | --- |
| Karigar | An operator: a person who runs machines. Shown as "Operator". |
| Hajari | Attendance. Derived from production (being on a slip marks you present), corrected by hand. |
| Upad | A salary advance, recovered from a later payslip. |
| Slip | A machine's shift report: stitches, time, thread breaks, frames. |
| Property | One customer's unit — the tenant. |

### Decided with the owner

- **Online-only.** The apps talk to this API directly; there is no offline
  sync. The server issues ids.
- **Node.js + PostgreSQL.** Database and photo storage on Supabase for now.
- **Five fixed roles**, no custom role creation until real users ask (§4).
- **Destructive actions are super admin only** (§4).
- **A web admin panel for us** (the platform) to create properties and
  manage their users. It is a separate repo.

---

## 2. The three repos

| Repo | Is | Talks to this repo through |
| --- | --- | --- |
| **FT-Backend** (this one) | The API (`api/`), the schema (`db/`), the contract package (`contract/`) | — |
| **Flutter** | The manager app (`apps/stitchflow`) and its shared core (`packages/sf_core`). A Crew app for operators is planned, not started. | The member API (`/v1/*`). The contract is mirrored **by hand** in Dart (`packages/sf_core/lib/src/api/api_json.dart` and `remote/*.dart`). |
| **StitchFlow-Web** | The web admin panel, Vue 3 + Vite, for our own staff | The console API (`/v1/platform/*`), through `@stitchflow/contract` packed into its `vendor/` folder |

**This repo is the source of truth** for the schema, permissions, endpoints
and their shapes. Neither client defines any of them.

The repo was seeded from the handover kit in the Flutter repo
(`docs/handover/`, kit 1.1.0). That kit is now history: everything in it that
matters lives here, and this repo has moved on (migrations 0006–0009,
contract 1.4.0).

### Changing something both sides see

| Change | Do it here | Then in the clients |
| --- | --- | --- |
| A table or a rule | New numbered file in `db/migrations/` — an applied migration is never edited. Views and functions in `db/views/` are re-applied on every deploy. `npm test` (db/check). | Usually nothing, unless a shape changes. |
| A permission | Starts in SQL: a new migration changing what `0003_access_catalog.sql` set. The contract's `catalog.json` is generated from it. | **Flutter:** `packages/sf_core/lib/src/domain/access.dart` holds a copy of the role → module defaults; update it by hand. The web panel has no permission logic. |
| An endpoint or a shape | `contract/spec/*.mjs`, then `npm run build -w contract`, bump `contract/package.json`, keep `docs/API.md` in step, implement in `api/`. | **Web:** `cd contract && npm pack --pack-destination ../../StitchFlow-Web/vendor`, then `npm install ./vendor/stitchflow-contract-<ver>.tgz` there and delete the old tarball. **Flutter:** edit `api_json.dart` / `remote/*.dart` by hand, then run its contract tests against `serve:test` (§6). |

Bump the contract's minor version for anything added, major for anything
removed or renamed. CI does **not** yet check that the generated contract
files are current, so run `npm run build -w contract` before committing.

---

## 3. Tenancy and identity

- **Property** — the tenant. A `code` (short handle), a name, a `timezone`
  (default `Asia/Kolkata`; "today" is always the property's own date, never
  the server's), a status (`active` / `suspended` / `closed`), a **machine
  limit**, and one row of `property_settings` (business name, currency,
  shift arrangement and day start, no-leave bonus, stitch-based rate).
- **User** — a person who signs in. Global, not per property: an owner of two
  units is one login with two memberships. Signs in with a **phone number
  (E.164)**, email or username, plus a password (argon2id). The manager app
  adds `+91` to a bare 10-digit number before sending it.
- **Member** — a user's place in a property: a role, a status, whether they
  are the **owner** (the main super admin, exactly one per property), and
  optionally the roster row (`staff_id`) they are.
- **Platform staff** — us. `admin` or `support`, signing in to the web admin
  panel. Not members of any property.

A new property is created from the console together with its owner. The
owner creates everyone else. A temporary password is shown once and must be
changed at first sign-in.

### The machine limit

A unit may have at most `properties.machine_limit` machines. **Only we set
it**, from the console. The apps' database role cannot update `properties`.

- Every machine not in the recycle bin counts, active or not. Restoring one
  takes a place again and is refused when none is left.
- The database enforces it (trigger `machines_within_limit`, `0005`), with a
  per-property lock so two adds at once cannot both slip through. Bulk add is
  all or nothing.
- Lowering the limit removes nothing; the unit simply cannot add until it is
  under again.
- The API answers `409 machine_limit_reached` with `details.limit`,
  `details.used`, and `details.requested` on bulk add. The apps read
  `GET /v1/machines/allowance` → `{ limit, used, left }`.

---

## 4. Roles and permissions

Encoded in `db/migrations/0003_access_catalog.sql`, checked by the functions
in `db/views/20_fn_access.sql`, proved rule by rule by `db/check`.

### The rules

1. **Anything destructive is super admin only.** Any delete — a machine, a
   person, a slip, an advance, a payslip, a bonus rule, a cleared month of
   attendance, anything removed for good, emptying the bin — and **any change
   to the shift schedule**.
2. Everyone else with edit on a module may add and change its data, and
   delete only what is not destructive (a single attendance day tapped back
   to unmarked). Restoring from the bin is not destructive.
3. **Owner only:** making or removing a super admin, transferring the
   property, wiping the unit's records.
4. **View admin is view only.** Nothing can make it an editor.
5. **A supervisor is never shown pay** — salaries, the roster, advances,
   payslips, bonus rules.
6. **Sub users get selected modules, never more than whoever made them has**
   (`fn_can_grant`; otherwise `grant_exceeds_granter`).

### Roles and modules

| Module | superAdmin | admin | viewAdmin | supervisor | worker |
| --- | --- | --- | --- | --- | --- |
| production | edit | edit | view | edit | edit |
| attendance | edit | edit | view | edit | view |
| advances | edit | edit | view | — | — |
| payroll | edit | edit | view | — | — |
| staff (roster) | edit | edit | view | — | — |
| machines | edit | edit | view | view | view |
| shifts | edit | view | view | view | view |
| bonus_rules | edit | edit | view | — | — |
| recycle_bin | edit | edit | view | — | — |
| users | edit | edit | view | edit | — |
| settings | edit | view (up to edit) | view | — | — |

Each cell is the default; a member's access can move between none and the
role's ceiling, which equals the default except admin's settings.

| Creator | May create |
| --- | --- |
| Owner | super admins, and everything below |
| Super admin | admin, view admin, supervisor, operator |
| Admin | view admin, supervisor, operator |
| Supervisor | operator |

Every endpoint checks one of the 42 actions in `0003` with
`fn_member_can(memberId, action)`: member, user and property active → owner
only? → destructive? → module level. Destructive actions and every console
action are written to `audit_log` with before and after.

**Custom roles are deliberately not built.** If units ask for named roles,
add a `roles` table keyed by property and point `property_members` at it;
`fn_member_level` and `fn_member_can` keep their shape.

---

## 5. Rules that are easy to break

- Every request is **one transaction** that takes the role `stitchflow_api`
  (or `stitchflow_platform`) and sets `app.property_id`. Row-level security
  then limits every query to the token's unit, behind the API's own checks.
- **Every view must be `security_invoker`**, or it reads as its owner and
  leaks other properties. `db/check` fails on any that is not.
- Every table with `property_id` must have row-level security (`db/check`).
- Dates without a time are `DATE` and `"YYYY-MM-DD"`. Money is `NUMERIC`.
- Parameterized SQL only. Enums are text with a CHECK.
- Writes carry an `Idempotency-Key`; the first response is replayed for 24
  hours (`0006`).
- Live-update notices are sent **after commit** (`tx.afterCommit`), never
  before.
- `api/src/domain/` (bonus, payroll, shifts) is ported from the Flutter
  core with its tests. Pay must come out identical on both sides; if a pay
  rule changes, change both and their tests together.

---

## 6. How it runs

- **API:** Node 24 runs the TypeScript directly (no build step), Fastify,
  `pg`. Handlers parse and respond; services hold the rules, in SQL against
  the views and functions.
- **Sign-in:** access token JWT HS256, 15 minutes. Refresh token opaque,
  stored hashed, **rotates on every use**; replaying a rotated one revokes
  its whole family. Sessions last 7 days, 15 with "keep me signed in" (the
  manager app always asks for 15). A user in several properties picks one
  with `POST /v1/auth/select-property`. `must_change_password` blocks every
  route except `/v1/auth/*` and `/v1/me` with `403
  password_change_required`. Failed sign-ins are rate limited in memory: 10
  per identifier and 50 per IP per 15 minutes, then `429 rate_limited`.
- **Console sign-in** is `/v1/platform/auth/login`, with optional TOTP
  (`0009`): set up, then enable; each code works once; an admin can turn it
  off for someone who lost their phone.
- **Live updates:** `GET /v1/events` is Server-Sent Events: `event: change`
  with `{table, ids}`, a ping every 25 s. The bus is in-process.
- **Photos:** `POST /v1/files` (multipart, with a purpose). Stored in a
  private Supabase Storage bucket and read through 10-minute signed URLs
  when `SUPABASE_URL` is set; otherwise on local disk with HMAC-signed
  `/files/raw/...` links.
- **Daily jobs** (in-process with `RUN_JOBS=true`, or `npm run purge -w api`
  from a scheduler): purge the bin past 7 days, expired sessions, old
  idempotency keys.

### The throwaway server, for clients

`npm run serve:test -w api` starts the API on `http://127.0.0.1:3900` over an
in-process PGlite database with every migration applied. Nothing is kept.
It adds two test-only routes:

- `POST /__test/property` `{machineLimit?}` → a fresh unit with one login per
  role: `{propertyId, code, password, usernames}`.
- `POST /__test/platform-staff` `{role?, mustChangePassword?}` → console
  staff: `{email, password, userId}`.

The Flutter repo's contract tests and the web panel's local development both
use it, so keep those routes stable.

---

## 7. Where things stand (7 October 2026)

**Built:** all 102 routes of contract 1.4.0 have handlers (3 public, 7
session, 72 member, 20 platform). `db/check` passes 100 rules. About 315 API
tests and 19 contract tests, none needing a database or network. CI
(`.github/workflows/ci.yml`) runs db/check, contract tests, typecheck and API
tests on pushes to main/dev.

### Hosted

| | |
| --- | --- |
| **API** | `https://13-237-211-26.sslip.io` (`/health` → `{"ok":true}`) |
| **Server** | One AWS EC2 instance, `stitchflow-api`: t4g.small, Ubuntu 24.04, Elastic IP `13.237.211.26`, region **Sydney** (`ap-southeast-2`) |
| **Containers** | `api` (the `Dockerfile` image, never exposed) and `caddy` (HTTPS on 80/443, Let's Encrypt), from `deploy/ec2/compose.yaml` |
| **Database and photos** | Supabase, Mumbai (`ap-south-1`) — the **same project** the developer's Mac uses, so both see the same data |
| **Deploys** | What is on GitHub (`khuntkk/FT-Backend`), not a laptop: push, then on the server `~/stitchflow/deploy/ec2/deploy.sh` (pull, build, migrate, restart; a failed migration leaves the old API serving) |
| **Daily jobs** | Inside the API (`RUN_JOBS=true`), one instance |
| **Web admin panel** | **Not hosted.** Run it locally against this API (StitchFlow-Web `HANDOVER.md`). |

Everything to build, run and repair the server is in
[`DEPLOY-EC2.md`](DEPLOY-EC2.md): launch, secrets, first deploy, the
everyday commands, troubleshooting. The server holds no data, so it can be
rebuilt or moved by repeating that guide.

**Temporary on purpose, to change before real users:**

- **Sydney, not Mumbai.** The AWS account is on the Free plan, which allows
  one region; for India that is Sydney. Every database round trip crosses to
  Mumbai (~150 ms), so a request takes 1–2 s. Don't judge speed from it.
  Moving to Mumbai needs a paid plan; then follow the guide in Mumbai and
  terminate the Sydney server.
- **`sslip.io`, not a domain.** It turns the IP into a hostname so Caddy can
  get a certificate. The address is compiled into the apps' builds, so put the
  API on a real domain (`api.<domain>`) before handing out builds widely —
  every change of address means a new APK.
- **One Supabase project for development and the server.** Local experiments
  change the hosted data. Split them when that starts to matter.
- **AWS Free plan ends** six months after sign-up, or when the credits run
  out (about $15/month for this server). Upgrade before then or the account
  closes (`DEPLOY-EC2.md`, "After six months").

The Flutter apps' builds for sharing point at this address
(`--dart-define=STITCHFLOW_API=https://13-237-211-26.sslip.io`). A unit and
its owner exist on it, and the manager app signs in and works against it.

To use the hosted API from a laptop instead of running one, point the
clients at it: the Flutter app through Settings → Data, the web panel with
`API_PROXY_TARGET=https://13-237-211-26.sslip.io npm run dev`.

**Security:** an earlier README carried the first console admin's temporary
password in plain text, and that version is pushed (`ea0f916` on
`origin/dev`). Change that account's password, and rewrite the history if the
repo is or will be shared.

### Not built yet

| Gap | Notes |
| --- | --- |
| Device import `POST /v1/import/device-snapshot` | Optional, one-time, owner-only: load a phone's local data into a property in one transaction, mapping ids, refused whole if over the machine limit. Only if a unit already has real data on a phone. |
| Report scans `/v1/production/scans` | The `slip_scans` table exists; the manager app does not call it yet (it uploads the slip photo only). |
| Crew app endpoints | `crewApp` is a client kind and `worker` a role; nothing Crew-specific yet. |
| OTP sign-in (SMS / WhatsApp) | Later, for operators. Phone is already the identifier. |
| Supervisor scoping to their own shift and machines | Needs an assignment table; "a later change" in `0003`. |
| More than one API instance | The SSE bus and the sign-in rate limiter are in memory. Before scaling out: Postgres `LISTEN/NOTIFY` for events, a shared store for rate limits, `RUN_JOBS=false` on all but one. |
| "See what they see" console view | Deferred (`API.md`). |
| Plans and billing | Only the machine limit exists, set by hand. |

---

## 8. Open decisions

| # | Decision | State |
| --- | --- | --- |
| 1 | Where the API runs | **Decided for now:** one EC2 container host behind Caddy (§7). Still open: Sydney → Mumbai (needs a paid AWS plan), and a real domain. The org standard names Lambda + Python; the owner chose Node and a container. |
| 2 | Which Postgres | Supabase (Mumbai), shared by development and the hosted API. Production needs point-in-time recovery on, a tested restore, and its own project. |
| 3 | Photo storage | Supabase Storage, private bucket, signed URLs. |
| 4 | Sign-in identifier on the floor | Phone + password now; OTP later. |
| 5 | Custom roles | Not now (§4). |
| 6 | Supervisor scoping | Later; needs an assignment. |
| 7 | Console second factor | Built (TOTP). Make it required before go-live. |
| 8 | Server-side reading of report photos | Only if on-device reading proves weak on real machine screens. |
| 9 | Plans, billing, other limits | Wait for pricing. |
| 10 | The apps' on-device mode | Kept as a demo until the owner decides. |

---

## 9. Where to look

| For | Read |
| --- | --- |
| Setup, env | [`README.md`](../README.md), `.env.example` |
| The hosted server | [`DEPLOY-EC2.md`](DEPLOY-EC2.md), `deploy/ec2/` |
| Every endpoint and its permission | [`docs/API.md`](API.md), `contract/spec/` |
| The contract package | [`contract/README.md`](../contract/README.md) |
| Permissions | `db/migrations/0003_access_catalog.sql`, `db/views/20_fn_access.sql` |
| The request pipeline | `api/src/http/router.ts` |
| Pay, bonus, shifts | `api/src/domain/`, `db/views/40_fn_payroll.sql`, `30_vw_attendance_days.sql` |
| What the apps expect | Flutter repo: `packages/sf_core/lib/src/api/` |
