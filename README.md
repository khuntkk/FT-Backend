# stitchflow-platform

The StitchFlow backend: the API the Flutter apps (manager app, Crew app) and
the web admin panel talk to, and the PostgreSQL schema behind it. The apps
live in the Flutter repo; the contract between them is [`docs/API.md`](docs/API.md).

The handover manual (`docs/handover/HANDOVER.md` in the Flutter repo) explains
the domain, the decisions, roles and permissions. This repo was seeded from
its `stitchflow-platform/` folder (kit 1.1.0).

| Path             | Is                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `api/`           | The API: Node.js 24 + TypeScript (run directly by Node, no build step), Fastify, `pg`. All 101 routes of the contract (1.2.0). |
| `db/migrations/` | The schema. Applied once each, in order.                                                                                       |
| `db/views/`      | Views (`vw_*`) and functions (`fn_*`): re-applied on every deploy.                                                             |
| `db/check/`      | Applies all of it to a throwaway Postgres and checks 100 rules hold.                                                           |
| `contract/`      | `@stitchflow/contract`: types, route table, permission rule, `openapi.json`. The API validates every request against it.       |
| `docs/API.md`    | Contract v1.                                                                                                                   |

## What you need

- **Node.js 24** or newer (`node -v`). The API runs TypeScript directly.
- **A Supabase project** (supabase.com). It provides the PostgreSQL database
  and the storage for photos. Pick the region nearest the units (Mumbai,
  `ap-south-1`). Note the database password you set when creating it.

**Tests need neither**: they run an in-process Postgres (PGlite) and a stand-in
for Supabase Storage.

## First run (development, on Supabase)

Everything secret goes into `.env` (git-ignored), never into the code or a chat.

1. Install:

   ```bash
   npm install
   ```

   ```bash
   cp .env.example .env
   ```

2. **Turn off Supabase's Data API.** In the Supabase dashboard, open Project
   Settings → Data API (or API) and disable it, or at least remove `public`
   from the exposed schemas. StitchFlow does not use it: the API connects to
   Postgres directly. Migration 0008 also revokes everything from the Data API's
   `anon` and `authenticated` roles, but there is no reason to leave the door open.

3. **Fill in `.env` from the dashboard:**

   | `.env`                                  | Where in Supabase                                                                                                            |
   | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
   | `MIGRATION_DATABASE_URL`                | **Connect** → _Session pooler_ URI, user `postgres.<project-ref>`, with your database password                               |
   | `DATABASE_URL`, `PLATFORM_DATABASE_URL` | Filled in at step 5                                                                                                          |
   | `DATABASE_CA_FILE`                      | Project Settings → Database → SSL Configuration → **Download certificate**; save it as `certs/supabase-ca.crt` (git-ignored) |
   | `SUPABASE_URL`                          | Project Settings → API (Data API) → Project URL, `https://<project-ref>.supabase.co`                                         |
   | `SUPABASE_SECRET_KEY`                   | Project Settings → API Keys → a **secret** key (`sb_secret_…`), or the legacy `service_role` key                             |
   | `JWT_SECRET`                            | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`                                   |

   A password with characters such as `@`, `#` or `/` must be URL-encoded inside
   the URLs (`encodeURIComponent` in Node).

4. **Create the schema:**

   ```bash
   npm run migrate
   ```

5. **Create the API's two logins.** In Supabase's SQL Editor (it runs as
   `postgres`), with two new strong passwords:

   ```sql
   create role api_login login password '<api password>';
   grant stitchflow_api to api_login;
   create role console_login login password '<console password>';
   grant stitchflow_platform to console_login;
   ```

   Then in `.env`, from **Connect** → _Transaction pooler_ (port 6543):
   `DATABASE_URL` with user `api_login.<project-ref>` and its password, and
   `PLATFORM_DATABASE_URL` with user `console_login.<project-ref>`. Each request
   is one transaction, so the transaction pooler suits the API.

6. **Make the first console admin** (prints a temporary password once):

   ```bash
   npm run create-platform-admin -w api -- --email you@example.com --name "Your Name"
   ```

7. **Run the API:**

   ```bash
   npm run dev
   ```

   It creates the private photo bucket (`stitchflow-photos`) in Supabase Storage
   on first start, and listens on `http://localhost:3000` (`GET /health`). An
   Android phone on the same Wi-Fi reaches it as `http://<your Mac's LAN IP>:3000`;
   debug builds of the app allow plain HTTP for that.

8. **Create a unit and its owner.** There is no web admin panel yet, so use the
   console API directly. Sign in, change the temporary password, sign in again:

   ```bash
   curl -s localhost:3000/v1/platform/auth/login -H 'content-type: application/json' -d '{"email":"khunt.kk2@gmail.com","password":"XjXwyJyGG6"}'
   ```

   ```bash
   curl -s localhost:3000/v1/auth/change-password -H "authorization: Bearer <accessToken>" -H 'content-type: application/json' -d '{"current":"<temporary>","next":"<your new password>"}'
   ```

   Then create the unit:

   ```bash
   curl -s localhost:3000/v1/platform/properties -H "authorization: Bearer <accessToken>" -H 'content-type: application/json' -d '{"code":"janki-creation","name":"Janki Creation","machineLimit":20,"owner":{"displayName":"Owner","phone":"+919812345678"}}'
   ```

   The answer holds the owner's temporary password. They sign in from the app
   with the phone number and that password and choose their own.

9. **Optional: two-factor sign-in for the console.** Signed in to the console:
   `POST /v1/platform/auth/totp/setup` returns a secret and an `otpauth://` URL.
   Add the secret to an authenticator app (Google Authenticator, Microsoft
   Authenticator, 1Password: "enter a setup key", time-based), then
   `POST /v1/platform/auth/totp/enable` with `{"code":"123456"}`. From then on
   console sign-in needs `"totpCode"` as well. Another admin can turn it off for
   someone who lost their phone (`DELETE /v1/platform/staff/:id/totp`).

### Without Supabase

Any PostgreSQL 16+ works (`brew install postgresql@17`). Run migrations as a
login that owns the `public` schema and has `CREATEROLE` (migration 0004
creates the roles `stitchflow_api` and `stitchflow_platform`), then create
`api_login` and `console_login` as in step 5. Leave `SUPABASE_URL` unset and
photos go to local disk (`FILES_DIR`). Connections to `localhost` are plain;
anything else uses TLS (`DATABASE_SSL`: `off`, `require`, `verify`).

## Tests

```bash
npm test
```

Runs the schema rules (`db/check`), the contract's tests, and the API's 318
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
- Photos go to Supabase Storage when `SUPABASE_URL` is set (a private bucket,
  read through 10-minute signed URLs), otherwise to local disk (`FILES_DIR`).

## Changes from the handover kit

- `db/migrations/0006_idempotency.sql`: stores the first response per
  `Idempotency-Key` for 24 hours.
- `db/migrations/0007_audit_actor_set_null.sql`: removing a member keeps
  their audit rows (by user) instead of blocking the removal.
- `db/views/50_vw_recycle_bin.sql`: fixed. A slip, advance or payslip
  deleted on its own never appeared in the bin (a NULL comparison). A check
  in `db/check` now pins it.
- `db/migrations/0008_close_supabase_data_api.sql`: nothing is reachable
  through Supabase's REST roles; `fn_user_memberships` is callable only by the
  API's roles. `db/check` simulates Supabase's default grants and proves it.
- `db/migrations/0009_platform_totp.sql` and four console endpoints:
  two-factor sign-in (TOTP) for console staff. Contract 1.2.0.
- `db/check`: every table carrying `property_id` must have row-level security.
