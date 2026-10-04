# stitchflow-platform

The StitchFlow backend: the API the Flutter apps (manager app, Crew app) and
the web admin panel talk to, and the PostgreSQL schema behind it. The apps
live in the Flutter repo; the contract between them is [`docs/API.md`](docs/API.md).

The handover manual (`docs/handover/HANDOVER.md` in the Flutter repo) explains
the domain, the decisions, roles and permissions. This repo was seeded from
its `stitchflow-platform/` folder (kit 1.1.0).

| Path | Is |
| --- | --- |
| `api/` | The API: Node.js 24 + TypeScript (run directly by Node, no build step), Fastify, `pg`. All 97 routes of contract v1. |
| `db/migrations/` | The schema. Applied once each, in order. |
| `db/views/` | Views (`vw_*`) and functions (`fn_*`): re-applied on every deploy. |
| `db/check/` | Applies all of it to a throwaway Postgres and checks 96 rules hold. |
| `contract/` | `@stitchflow/contract`: types, route table, permission rule, `openapi.json`. The API validates every request against it. |
| `docs/API.md` | Contract v1. |

## What you need

- **Node.js 24** or newer (`node -v`). The API runs TypeScript directly.
- **PostgreSQL 16 or newer**, with the `citext` and `btree_gist` extensions
  (both ship with Postgres). For development on a Mac:

  ```bash
  brew install postgresql@17
  ```
  ```bash
  brew services start postgresql@17
  ```

  Postgres.app or Docker work as well. **Tests do not need Postgres**: they run an
  in-process Postgres (PGlite).

## First run (development)

1. Install:

   ```bash
   npm install
   ```

2. Create the database and the schema owner. Migrations run as the owner;
   the API connects as two logins with fewer rights (step 4), and row-level
   security keeps each request inside one unit. With Homebrew's Postgres your
   macOS user is a superuser, so:

   ```bash
   createdb stitchflow
   ```
   ```bash
   psql stitchflow -c "create role stitchflow_owner login createrole password 'owner-dev'; grant create on database stitchflow to stitchflow_owner; alter schema public owner to stitchflow_owner;"
   ```

   (`createrole` because migration 0004 creates the roles `stitchflow_api`
   and `stitchflow_platform`. `citext` and `btree_gist` are trusted
   extensions, so the owner can install them.)

3. Configure and migrate:

   ```bash
   cp .env.example .env
   ```

   In `.env`, set `JWT_SECRET` (generate one below) and keep the three URLs
   as they are, or change the passwords to match what you create in steps 2 and 4.

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   ```bash
   npm run migrate
   ```

4. Create the API's two logins (the roles they join exist now):

   ```bash
   psql "postgres://stitchflow_owner:owner-dev@localhost:5432/stitchflow" -c "create role api_login login password 'change-me'; grant stitchflow_api to api_login; create role console_login login password 'change-me'; grant stitchflow_platform to console_login;"
   ```

5. Make the first console admin (prints a temporary password once):

   ```bash
   npm run create-platform-admin -w api -- --email you@example.com --name "Your Name"
   ```

6. Run the API:

   ```bash
   npm run dev
   ```

   It listens on `http://localhost:3000` (`GET /health`). An Android phone on
   the same Wi-Fi reaches it as `http://<your Mac's LAN IP>:3000`; debug builds
   of the app allow plain HTTP for that.

7. Create a unit and its owner. There is no web admin panel yet, so use the
   console API directly (the console admin's temporary password must be
   changed first):

   ```bash
   curl -s localhost:3000/v1/platform/auth/login -H 'content-type: application/json' -d '{"email":"you@example.com","password":"<temporary>"}'
   ```
   ```bash
   curl -s localhost:3000/v1/auth/change-password -H "authorization: Bearer <accessToken>" -H 'content-type: application/json' -d '{"current":"<temporary>","next":"<your new password>"}'
   ```

   Sign in again with the new password, then:

   ```bash
   curl -s localhost:3000/v1/platform/properties -H "authorization: Bearer <accessToken>" -H 'content-type: application/json' -d '{"code":"janki-creation","name":"Janki Creation","machineLimit":20,"owner":{"displayName":"Owner","phone":"+919812345678"}}'
   ```

   The answer holds the owner's temporary password. They sign in from the app
   with the phone number and that password and choose their own.

## Tests

```bash
npm test
```

Runs the schema rules (`db/check`), the contract's tests, and the API's 304
tests. Each API test file gets its own throwaway database. One file:

```bash
node --test api/test/payroll.test.ts
```

Typecheck: `npm run typecheck`. CI (`.github/workflows/ci.yml`) runs all of it.

## How the API is built

```
api/src/
  server.ts           runs the app; the daily jobs on a timer
  app.ts              Fastify, error handling, signed photo URLs
  http/router.ts      registers every route in the contract's table, each wrapped in the same steps:
                      token → one transaction (database role + app.property_id) → member, statuses,
                      password gate → fn_member_can(action) → Idempotency-Key → handler →
                      audit row (destructive and console actions) → commit → live-update notices
  handlers/           one file per endpoint group: parse → call service → respond
  services/           the rules, in SQL against the schema's views and functions
  domain/             pure rules ported from the apps' sf_core with their tests:
                      bonus, payroll (calculateSalary), shifts (versioning, Smart Adjust)
  auth/               JWT (HS256, 15 min), rotating refresh tokens, argon2id
  db/                 pg pool, transactions, migrations
  jobs/               daily: purge the bin past 7 days, expired sessions and idempotency keys
  storage/            photo bytes (local disk for now)
```

Rules that are easy to break:

- Every request is one transaction that takes the role `stitchflow_api` and
  sets `app.property_id`; row-level security then limits every query to the
  token's unit, behind the API's own checks.
- Dates without a time are `DATE` and `"YYYY-MM-DD"`; "today" is the unit's
  date in its time zone, never the server's.
- Destructive actions are super admin only (the catalog in
  `db/migrations/0003_access_catalog.sql` says which), and audited.
- The machine limit is enforced by the database (`0005`); the API maps its
  error to `409 machine_limit_reached`.
- Parameterized SQL only.

## Production

- `Dockerfile` builds the API as one container (`node src/server.ts`).
- Set the environment from `.env.example` through the host's secret store.
- Run `npm run migrate` (as the schema owner) on each deploy before starting.
- Behind HTTPS. Set `TRUST_PROXY=true` behind a load balancer.
- The daily jobs run inside the API (`RUN_JOBS=true`); with more than one
  instance, set `RUN_JOBS=false` and run `npm run purge -w api` once a day
  from a scheduler.
- Photos are on local disk (`FILES_DIR`): use a persistent volume, or wire
  object storage into `api/src/storage/storage.ts` (open decision #3).

## Changes from the handover kit

- `db/migrations/0006_idempotency.sql`: stores the first response per
  `Idempotency-Key` for 24 hours.
- `db/migrations/0007_audit_actor_set_null.sql`: removing a member keeps
  their audit rows (by user) instead of blocking the removal.
- `db/views/50_vw_recycle_bin.sql`: fixed. A slip, advance or payslip
  deleted on its own never appeared in the bin (a NULL comparison). A check
  in `db/check` now pins it.
- `db/check`: every table carrying `property_id` must have row-level security.
