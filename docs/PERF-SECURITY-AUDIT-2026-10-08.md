# API performance, security and call-volume audit (8 October 2026)

Scope: the API in this repo as deployed on EC2 Sydney with the database on
Supabase Mumbai, plus the two clients that call it (the Flutter apps in
`/Users/jalpa/Kaushik/Flutter`, the Vue admin panel in
`/Users/jalpa/Kaushik/StitchFlow-Web`). Every finding below was produced by
one reviewer reading the code and then checked by two independent reviewers,
one trying to refute the claim against the code and one judging the fix. The
recommendations are the corrected versions. Line numbers are as of commit
`bc7acf5` on `dev`.

## 1. The shape of the problem

Every request runs as one database transaction, and node-pg sends one
statement at a time. With the API in Sydney and the database in Mumbai each
statement is a 150–200 ms round trip, so the cost of a request is almost
entirely the number of serial statements:

| Request | Serial DB round trips today | Time at ~170 ms |
| --- | --- | --- |
| Member GET with one query (e.g. `/v1/machines`) | 6 (begin, set_config, MEMBER_SQL, fn_member_can, query, commit) | ~1.0 s |
| Member write with `Idempotency-Key`, one statement | 8 (adds the key claim and the stored response) | ~1.4 s |
| `GET /v1/me` (app start) | 8 (four shape selects in a row) | ~1.4 s |
| `PUT /v1/production/entry` (the slip save) | 14–18 (7–11 inside the handler) | 2.4–3 s |
| `POST /v1/auth/refresh` | 7 | ~1.2 s |
| Photo view `GET /v1/files/:id` | 5+ plus one Supabase sign call | 1–1.5 s per photo |

On top of that, the first request after any pause pays a fresh TCP + TLS +
SCRAM connect to Mumbai (pool connections are dropped after 10 s idle), the
phone pays a fresh TLS handshake to Sydney after any 3 s gap (Dio's default),
JSON is sent uncompressed, and the apps make far more requests than they need
(4 requests per staff member for the payroll preview, one authenticated
request per photo, a refetch of every live list on every change notice).

Two levers dominate everything else:

1. **Put the API next to the database** (AWS ap-south-1). Round trips drop
   from ~170 ms to 1–3 ms: 10–20× on every call, no code change.
2. **Cut serial statements per request.** Worth doing regardless of the move,
   because it also lifts the throughput ceiling of the 10-connection pool.

## 2. Phase 1: quick wins (hours each, no contract change)

### Transport and edge (`deploy/ec2/Caddyfile`, `api/src/app.ts`)

- **Compress JSON at Caddy.** Add `@compressible not path /v1/events` and
  `encode @compressible zstd gzip` inside the site block. Caddy's default
  matcher includes `text/*`, which would catch the SSE stream, so the path
  exclusion matters. Do not add `@fastify/compress` as well. Deploy with
  `docker compose up -d --force-recreate caddy` (a plain reload can see a
  stale bind-mounted file). Verify with `curl --compressed -D-` on a list
  endpoint and `curl -N` on `/v1/events`.
- **Security headers at Caddy only:** `Strict-Transport-Security
  "max-age=31536000"`, `X-Content-Type-Options nosniff`, `Referrer-Policy
  no-referrer`, `-Server`. Add `servers { timeouts { read_header 15s } }`
  globally and `request_body { max_size 20MB }`. Do not set `read_body` or
  `read` (they would cut SSE on HTTP/1.1 clients).
- **Keep-alive race:** Fastify closes idle sockets at 72 s, Caddy keeps them
  for 2 min. Add `keepAliveTimeout: 130_000` to the `Fastify({...})` options
  (or `transport http { keepalive 60s }` in `reverse_proxy`, not both).
- **`Cache-Control: no-store`** on every API JSON response via an `onSend`
  hook (skip the local `/files/raw/*` route and the hijacked SSE route).
- **Request ids:** drop `requestIdHeader: 'x-request-id'` so ids are always
  server-minted, and add an `onRequest` hook that echoes `x-request-id` back
  (plus `access-control-expose-headers` in the CORS block) so a user can
  quote it to support. Today a client can plant free text in
  `audit_log.request_id` and nothing is echoed.

### Database connection (`api/src/db/db.ts`, `api/src/config.ts`)

- **Pool options** (both pools): `idleTimeoutMillis: 600_000` (or `0`),
  `keepAlive: true`, `keepAliveInitialDelayMillis: 30_000`,
  `connectionTimeoutMillis: 10_000` (covers queue wait, under the phone's
  20 s), `query_timeout: 20_000`, `maxLifetimeSeconds: 3600`,
  `application_name: 'stitchflow-api'`. Add `pool.on('error', …)` on both
  pools: without it an idle connection dropped by Supavisor crashes the
  process. Note `min` does not pre-warm in pg-pool 3.14; the long idle timeout
  is what keeps connections warm.
- **Server-side limits per transaction**, in the same set_config statement
  (transaction pooler, so not as startup parameters):
  `set_config('statement_timeout','15000',true)` and
  `set_config('idle_in_transaction_session_timeout','20000',true)`. Map
  SQLSTATE 57014 to a 503 with `retryAfter` in `http/errors.ts`.
- **One round trip to open the transaction.** Replace the separate `begin`
  and `select set_config(...)` with one parameterless simple-protocol query:
  `begin; select set_config('TimeZone','UTC',true), set_config('role',<role>,true), set_config('app.property_id',<pid>,true), …`
  using `pg.escapeLiteral` for the two server-controlled values (role is a
  closed set, property id is an integer from a server-signed token; keep the
  `null → ''` mapping). pg returns an array of results for a multi-statement
  string and the PGlite test harness already handles it. Add a one-line
  exception to the "Parameterized SQL only" rule in the README. Optionally
  open GET transactions with `begin read only`.
- **Verify the database certificate.** In `pgOptions` change the remote
  default from `'require'` (which sets `rejectUnauthorized: false`) to
  `'verify'`; a remote host with no `DATABASE_CA_FILE` then fails at start
  with the existing error. Keep `require` and `off` as explicit, loud opt-ins
  (`process.emitWarning`). `.env.example` and `DEPLOY-EC2.md` already
  describe `verify`; this makes it the default rather than a manual step.

### Request pipeline (`api/src/http/router.ts`, `api/src/handlers/auth.ts`)

- **Fold the action check into `MEMBER_SQL`.** Add
  `fn_member_can(m.id, $4::text) as allowed` and pass `route.action ?? null`;
  use the returned flag instead of the separate `checkAction` statement for
  member routes (keep `checkAction` for handlers' later `assertCan` calls).
  One round trip off every member request.
- **Session liveness in the same row, for free.** Add a column to
  `MEMBER_SQL` (and the platform `loadStaff` query) that checks the token's
  `sid` family is still live in `auth_sessions`, evaluated after the status
  gate. Today logout, "sign out everywhere" and support sign-out leave the
  access token valid for its remaining 15 minutes. Also validate claim types
  after `JSON.parse` in `tokens.ts` (`sub` safe integer, `sid` uuid, `mid`/
  `pid` null or integer, `client` in the known set).
- **`GET /v1/me` as one statement.** Four `row_to_json` subselects reusing
  the column fragments from `shapes.ts`; normalise the three instants that
  `PARSERS` would otherwise have converted. 8 round trips become 5 (4 with
  the merged open). This runs on every cold start, sign-in and property
  switch.
- **Change-password revokes other sessions.** After the `update users …` in
  `changePassword`, revoke every live `auth_sessions` row of the user whose
  `family_id` differs from the caller's (`is distinct from` fails closed).
  Today an attacker's refresh token keeps rotating indefinitely after the
  victim changes the password, because every refresh restarts the 7/15-day
  clock.

### Uploads and rate limiting (`api/src/app.ts`, `api/src/handlers/files.ts`)

- **Read the multipart body before the transaction opens.** Register
  `@fastify/multipart` with `attachFieldsToBody: 'keyValues'` so the file is
  buffered in preValidation, and set `requestTimeout: 120_000`. Today the
  handler reads the stream while holding one of the 10 pooled connections,
  so ten slow uploads (even trickle uploads from one signed-in account) stall
  every request in every property, with no 503 because the pool waits
  forever. The `connectionTimeoutMillis` above is the second half of this
  fix. Optionally `request_buffers 20MB` on the Caddy `reverse_proxy`.
- **Per-IP throttle on the three unauthenticated routes** (`/v1/auth/login`,
  `/v1/auth/refresh`, `/v1/platform/auth/login`) with `@fastify/rate-limit`
  (`global: false`, `hook: 'onRequest'`, return the contract's
  `rate_limited` error body). An unknown refresh token today costs four
  Mumbai round trips and a login about ten, all before any limit applies.

### Queries that scale with history instead of with the day

- **Rewrite `vw_attendance_days` as `UNION ALL`** (`db/views/30_vw_attendance_days.sql`).
  The `FULL JOIN` with `COALESCE` output columns defeats predicate pushdown,
  so every attendance read and the payroll preview aggregate the property's
  entire production history. Verified on a 32k-entry seed: `/attendance/day`
  goes from ~100 ms to ~1 ms of DB time; `/attendance/daily` only ~1.7×.
  Views are re-applied on deploy, so no migration. In the same change make
  `with bounds as not materialized` in `fn_payroll_inputs` so the month
  range pushes into both branches (preview went 99 ms → 46 ms on the seed).

### Flutter, client-only

- **Keep sockets warm.** Dio's default `HttpClient.idleTimeout` is 3 s, so
  almost every tap pays a new TLS handshake to Sydney. In `ApiClient`'s
  constructor set an `IOHttpClientAdapter(createHttpClient: () => HttpClient()..idleTimeout = const Duration(seconds: 90))`
  and share it with the bare client used for refresh.
- **Shrink the change-notice fan-out** (`server_events.dart` `_derived`):
  a slip notice today also refetches payslips, advances and the recycle
  bin. Keep `shifts → production`, `staff → {payslips, attendance,
  production}`, `settings → payslips`; make the recycle-bin provider lazy
  (`autoDispose`); make `liveFetch` pause-aware so hidden tabs catch up once
  on switch instead of refetching on every notice.
- **One owner for catch-up refetches.** Move `refreshAll()` to after a
  successful SSE reconnect (skip the first connect) and delete the call on
  disconnect, which today fires while the phone may still be offline. Add a
  60 s no-bytes watchdog on the stream (the server pings every 25 s).

### Operations

- **Clean shutdown.** Track SSE responses in the `EventBus` and end them in
  a Fastify `preClose` hook (not `onClose`, which runs after `server.close()`
  and never fires while a stream is open). Every deploy today stalls 10 s and
  is then SIGKILLed.
- **Container limits:** `mem_limit: 768m`, `memswap_limit: 768m`,
  `NODE_OPTIONS=--max-old-space-size=384` on the api service, so a memory
  spike restarts the container instead of swapping the 2 GiB host.
- **Refresh base images:** `docker compose build --pull api` and
  `docker compose pull caddy` in `deploy.sh`.

## 3. Phase 2: next (days, still no contract change)

- **Slip save as 2 statements** (`services/production.ts`). One READ that
  returns the machine/shift/scan facts, the valid karigar ids, the rules, the
  settings and `fn_member_can(…,'payroll.view')` as columns, then one WRITE
  as a data-modifying CTE (upsert entry, delete + insert `entry_karigars`,
  link the scan, select the result). 14–18 round trips become 7–9.
- **Stop re-reading after writes.** `insert … returning ${COLUMNS}` and
  `update … returning` in `machines.ts`, `staff.ts` and the others instead of
  `returning id` followed by `get()`.
- **Idempotency as one upsert** that both claims the key and returns any
  stored response; then store the response, write the audit row and commit
  with fewer awaits (CTE or pg `pipeline: true`).
- **Refresh path 7 → 5 round trips** (`services/auth.ts`): one RLS-safe
  statement joining `fn_user_memberships(s.user_id)` (security definer) for
  the session + user + membership + platform role, then one CTE for rotate +
  insert. Client side, refresh proactively a minute before `expiresIn` so
  the stall never lands on a user action.
- **Photo view as one query.** Find the file and evaluate every permitted
  view action in one statement (`jsonb_array_elements_text` over
  `VIEW_ACTIONS`); keep 404-before-403 ordering. Do not add a server-side
  signed-URL cache as first proposed: the app holds a URL for 9 of its 10
  minutes, so a cached URL could expire while displayed.
- **Flutter on-disk photo cache** keyed by file id, consulted before asking
  the server for a URL (files are immutable per id). This removes the
  per-photo API request on every launch and after every 9-minute expiry.
- **Flutter: use `GET /v1/payroll/preview`.** The app still computes the
  preview itself with 2–4 sequential requests per staff member (about 60–120
  requests at 30 staff, each ~1 s). The endpoint already exists in contract
  v1; add the JSON mapping and a `watchPreview` stream on the payroll
  repository.
- **Flutter cold start:** reuse `currentShiftsProvider` for today's date
  instead of a second `/v1/shifts?on=`, drop the duplicate roster fetch
  (`staffListProvider` vs `karigarsProvider`), pass `year` to
  `watchPayments`. About 3 of the ~9 serialized start-up requests go away.
- **Indexes** (new migration `0010_…`): `production_entries (property_id, deleted_at) where deleted_at is not null`,
  `attendance_marks (property_id, deleted_at) where deleted_at is not null and deleted_batch is not null`,
  `audit_log (occurred_at desc, id desc)`, `auth_sessions (member_id, created_at desc)`.
  Make `recycleBin.empty()` set-based instead of a per-item loop. Plain
  `create index` only: `migrate.ts` wraps each file in a transaction.
- **SSE hygiene:** cap streams per member (evict the oldest at 10), close a
  member's streams when their sessions are revoked, one shared ping timer.
- **Web admin:** run `GET /v1/platform/me` in parallel with the page's own
  fetch after a refresh instead of before it; `KeepAlive` for the three list
  pages with a 60 s freshness rule; filter properties client-side (the
  endpoint already returns the whole list); apply mutation responses to the
  page state instead of refetching; debounce and sequence-guard the audit
  filters.
- **Fastify `response` schemas: do not add for speed.** fast-json-stringify
  gives no measurable gain here and, as the contract's schemas stand
  (`anyOf` + `multipleOf` money fields), would turn ordinary rupee amounts
  into 500s on four list routes. If you want outbound shape enforcement,
  it needs `serializerOpts.ajv.multipleOfPrecision` and fixtures first.
- **ETag/304: skip.** Compression captures nearly all the byte saving, and
  the only client that would send `If-None-Match` is the admin panel.

## 4. Phase 3: larger moves

- **Move the API to ap-south-1.** The single biggest lever (10–20× on every
  call, pool ceiling from ~8 req/s to hundreds). It needs the AWS paid plan.
  Get a real domain first (`api.<domain>` → Sydney IP, 60 s TTL), rebuild the
  apps once against it, then launch the Mumbai instance, repeat the deploy
  steps and flip the record. Do not move the database to Sydney instead:
  users and Storage are in India. Any Mumbai-region Docker host works with
  the same compose files if AWS is the blocker.
- **Contract 1.5.0 (additive, one bump, batch these):**
  `photoUrl` on `Staff`/`Person`/`Machine` and `slipPhotoUrl` on
  `ProductionEntry`, signed in one batched Storage call per list (removes
  N photo requests per roster or day screen); `actorName` and `propertyName`
  on `AuditEntry` (the audit page is N+1 today, through the 4-connection
  platform pool); `machineId` on `/production/entries`; `year` on
  `/advances`. A bootstrap endpoint that folds `/me`, settings, shifts and
  machines into the login response is the next step after those, not
  before.
- **SSE replay.** A `Last-Event-ID` / replay window so a reconnect refetches
  only what changed instead of every live list. Client side, per-id
  invalidation once lists cache by id.
- **Host the admin panel on the API origin behind Caddy** when it is hosted
  at all (today it runs through Vite's proxy, so there are no preflights
  yet). Proxy `/v1/*`, `/health` and `/files/raw/*` to the API, serve the
  SPA for the rest, hash-named assets immutable.
- **Multi-process is not needed** at this size, and the in-process SSE bus
  and limiter would have to move to Postgres `LISTEN/NOTIFY` and the
  database first.

## 5. Security findings, by severity after review

| Severity | Finding | Fix (section) |
| --- | --- | --- |
| high | Slip reads return bonus pay to supervisors and operators, against the documented rule | §6.1 |
| high | Sign-in lockout keyed by identifier alone, never reset, inside the transaction: anyone can lock a user out | §6.2 |
| high | Fresh `Idempotency-Key` per HTTP call: a re-tap after a lost response records an advance twice | §6.4 |
| high | A lost refresh reply makes the retry look like token theft and signs the user out | §6.4 |
| high → medium | Uploads buffered inside the open transaction; pool waits forever; authenticated denial of service | §2 uploads |
| medium | `/v1/me` hands every role the pay-rate settings that `/v1/settings` withholds | §6.1 |
| medium | Workers can read every colleague's attendance via `/attendance/day` | §6.1 |
| medium | Console sign-in does not require the second factor; TOTP guesses limited only by an in-memory counter | §6.2 |
| medium | Sign-in reveals which phones and emails have an account (reason and timing) | §6.2 |
| medium | Only failed password checks are rate limited; refresh/login/platform login unthrottled | §2 uploads and rate limiting |
| medium | Change-password does not revoke other sessions; refresh keeps the attacker signed in indefinitely | §2 request pipeline |
| medium → low | Access token `sid` never checked; logout leaves a 15-minute window | §2 request pipeline |
| medium → low | `DATABASE_SSL=require` default skips certificate verification on the cross-region link | §2 database connection |
| medium → low | No HSTS/nosniff/Referrer-Policy, no `no-store` on token responses | §2 transport |
| medium → low | Client-controlled `x-request-id` lands in `audit_log`, never echoed | §2 transport |
| medium → low | SSE streams uncapped per member, not closed on revocation | §3 |
| low | DB error text reaches clients; `trustProxy: true` is safe only while Caddy is the only ingress (it is, `expose:` not `ports:`) | map DB errors generically |
| low | Base images never re-pulled; no memory limit | §2 operations |

## 6. Gap round: four angles the first pass missed

A completeness reviewer named four under-covered angles; one reviewer each
then read the code. These did not get the two-reviewer check the findings
above had, so the four highest-impact claims (bonus leak, lockout, per-call
idempotency key, refresh rotation) were re-verified by hand against the code
before being written here. Line numbers as above.

### 6.1 Read-side authorization: pay reaches roles that must never see it

The handover (`docs/HANDOVER.md:133`) and the access catalog
(`db/migrations/0003_access_catalog.sql:67-69`) say a supervisor is never
shown pay, and give supervisor and worker `payroll: none`. The write side
honours this (`withPermittedBonus`), the read side does not.

- **Slip reads return bonus pay to everyone with `production.view`** (high).
  `ENTRY_SELECT` (`api/src/services/production.ts:27-30`) selects
  `bonusAmount`, `bonusIsManual` and the per-operator split, and the GET
  handlers (`handlers/production.ts:9-21`) pass no member to mask by. A
  supervisor or operator can page `GET /v1/production/entries?from=&to=`
  (500 per page, no span cap) or filter by `staffId` and read any
  colleague's bonus for any period, and infer the bonus ladder. The Flutter
  app hides the figure only in the UI. Fix: add
  `fn_member_can(m.id,'payroll.view') as "canSeePay"` to `MEMBER_SQL`
  (must come from `fn_member_can`, not from `grants`, which holds only the
  member's own overrides), make `ENTRY_SELECT` a function of that flag that
  emits `null::numeric` for the three fields, thread `member` through
  `getById`/`find`/`day`/`page` (always unmasked in `remove()` because the
  row goes to the audit log), and drop the separate `fn_member_can` query in
  `withPermittedBonus` (one round trip saved on every slip save). Contract
  stays stable if the fields return 0/false; preferred is loosening
  `bonusAmount`/`bonusPerKarigar` to nullable money, a response-only change
  that the app already tolerates. Move the `bonusAmount` assertions in
  `production.test.ts` and `security.test.ts:80` from worker/supervisor to
  admin and add null-for-supervisor cases.
- **`GET /v1/me` embeds the full settings, including the two pay rates**
  (medium). `handlers/auth.ts:40` returns `getSettings()` to any member,
  while `GET /v1/settings` is correctly refused to supervisors and workers
  (`settings: none`, `0003:80,93`). `noLeaveBonusAmount` and
  `stitchBasedRatePerThousand` are pay rates. Fix: a masked settings query
  for `/me` only (`case when fn_member_can($2,'settings.view') or
  fn_member_can($2,'payroll.view') then … end`), folded into the
  one-statement `/me` from §2. Keep `getSettings()` unchanged for the bonus
  computation.
- **A worker can read every colleague's attendance through
  `GET /v1/attendance/day`** (medium). `attendance.day()` takes no member
  and returns every active person (`services/attendance.ts:20-30`); the
  own-only guard exists only on `/staff/:id/attendance` (`attendance.ts:57`).
  Fix: pass the member and add `and (not $3::boolean or s.id = $4::bigint)`.
  Smaller response for workers, no contract change.
- **Change notices go to every member and streams are never
  re-authorised** (low). `EventBus.emit` is keyed by property only
  (`http/events.ts:16`), so supervisors and operators learn when advances,
  payslips and bonus rules change (ids only, no amounts), and disabling or
  removing a member does not close their stream. Fix: register listeners
  with the tables their modules allow (one query per connect), filter on
  emit, and add `EventBus.drop(memberId)` called from the users handlers.
  Combine with the per-member stream cap in §3.

### 6.2 Sign-in path

- **The sign-in lockout is a denial-of-service lever** (high).
  `assertAllowed(idKey)` runs before the password check (`auth.ts:98`), the
  key is the identifier alone, nothing resets it on success (no caller of
  `clear()`), and the console login shares it (`auth.ts:150`). Ten wrong
  passwords against a known phone number or the admin's email lock that
  person out for 15 minutes, repeatably. The check also runs inside the open
  transaction, so a 429 still costs begin + set_config + rollback and a
  pooled connection; the per-IP cap of 50 counts typos and can trip for a
  whole unit behind one CGNAT or Wi-Fi address. Fix: run the limiter in
  `dispatch` before `db.api()`/`db.platform()` for the three unauthenticated
  routes; key the hard limit on identifier + IP and turn the identifier-only
  counter into a progressive delay; reset on success; raise the per-IP cap
  to ~200 for sign-in routes and collapse IPv6 to /64; cap identifier
  (254) and password (256) lengths before they become `Map` keys.
- **Cold sign-in is 16–22 serial round trips** (high, performance). Login
  alone is 8 (`auth.ts:101,112,126,78,135`), select-property 6, `/me` 8.
  Fix without a contract change: `update users … returning ${USER_COLUMNS}`
  replaces the re-select, and one data-modifying CTE does the
  last-login update, `fn_user_memberships`, the session insert and the
  chosen-membership pick (login 8 → 5, 4 with the merged open). Argon2 is
  2–3% of the connection hold time; leave `UV_THREADPOOL_SIZE` alone. With
  a contract bump, add `me` to `LoginResult` and to the select-property
  response so the app skips `GET /v1/me` (single-unit chain 16 → 5).
- **Console sign-in does not require the second factor** (medium).
  `checkAtSignIn` returns null when TOTP is not enrolled
  (`platformTotp.ts:84`); handover decision 7 says to require it before
  go-live. Fix: `REQUIRE_PLATFORM_TOTP` defaulting to true in production;
  `loadStaff` already selects from `platform_staff`, so add
  `totp_enabled_at is not null` there at no cost and refuse everything but
  `/platform/me`, the TOTP setup/enable routes and `/v1/auth/*` with
  `forbidden` + `details.reason: totpSetupRequired`. Give wrong TOTP codes
  their own stricter counter.
- **Sign-in reveals which phones and emails have an account** (medium).
  `details.reason` is `noSuchUser` vs `wrongPassword` (`auth.ts:109-110`,
  documented in `docs/API.md:78`), and an unknown identifier skips argon2
  (`passwords.ts:16`) so timing differs too. The console login confirms any
  tenant user's email. Fix: one reason (`wrongPassword`, which the app
  already maps) and a neutral message; verify against a startup dummy hash
  when there is no stored hash; next app release rewords the error.

### 6.3 Photo bytes and the upload sequence

- **Thumbnails download the originals** (high). The server stores the
  uploaded bytes as the only rendition (`services/files.ts:98`) and lists
  show them at 28–104 dp, so a production list with 30 machine photos is
  roughly 7.5 MB where ~0.6 MB would do; a 48 dp slip preview pulls a
  ~1 MB 2400 px image. Bytes go Supabase → phone directly, so Caddy cannot
  help. Fix: a server-side 320 px JPEG rendition with `sharp` at upload
  (prebuilt arm64 binary, store at `<key>_t.jpg`, nullable `files.thumb_key`,
  backfill job), exposed as `GET /v1/files/:id?size=thumb` and as the
  embedded `photoThumbUrl` once list responses carry URLs (same 1.5.0
  bump). Supabase image transformations are the no-dependency alternative
  if the plan includes them.
- **Save waits for the slip photo upload** (high). `saveEntry` evaluates
  `uploadIfLocal` while building the PUT body (`remote/production.dart:77`),
  so Save = ~1 MB uplink + 6 round trips + two Storage calls + the 14–18
  round-trip PUT, about 7 s typical. Fix, client only: start the upload in
  the background right after capture, keep the Future, swap the draft path
  to the file id on success so a retried Save never re-uploads, and memoise
  in-flight uploads by path.
- **Full-resolution decode and no disk cache** (medium). `MachinePhoto` and
  `StaffPhoto` pass no `cacheWidth` (`ui/photos.dart:46,119`), so each
  1280 px photo decodes to ~4.9 MB and 20 of them fill Flutter's 100 MiB
  image cache; every eviction, 9-minute re-sign or cold start re-downloads
  the original. Fix: `cacheWidth` from the layout size times the device
  pixel ratio (one line), plus the on-disk cache keyed by file id from §3,
  storing the thumbnail.
- **Retried or abandoned uploads duplicate and orphan files; nothing ever
  deletes one** (medium). `POST /v1/files` is a session route, so the router
  skips the idempotency claim; a failed PUT leaves the local path in the
  draft, so the next Save uploads again; `Storage.remove` has no caller and
  the daily job never touches files. At ~60 slips a day that is ~1.8 GB a
  month of unreclaimed storage. Fix: dedupe on `(property_id, purpose,
  sha256)` at upload (the hash is already computed), a 48-hour
  reference-based orphan sweep in `jobs/daily.ts`, and rebuild the
  `FormData` on the token-refresh retry (today a finalized form throws, so
  the first upload after a 15-minute idle fails).

### 6.4 Retries and exactly-once writes on mobile networks

- **A fresh `Idempotency-Key` is minted on every HTTP call** (high). The
  comment at `api_client.dart:150-152` says "one key per user action", but
  `newIdempotencyKey()` runs inside `_call` (`:153-154`), so the key lives
  for exactly one request. A lost response or the 20 s receive timeout,
  then a second tap, inserts a second advance (money, no natural unique
  key: `services/advances.ts:65`), a duplicate bonus rule, or another slip
  photo; naturally keyed writes answer a misleading 409 instead of the
  original success. `DELETE` and `PATCH` send no key although the server
  honours one on every non-GET. Fix, ~30 lines client only: a pending-key
  map keyed by method + path + body with a 10-minute TTL, cleared only on a
  definitive answer, sent on every non-GET; refresh the list on ambiguous
  failure so the user sees the first attempt landed; memoise uploads by
  path.
- **Refresh-token rotation is not safe against a lost reply** (high). The
  server marks the old token `rotated` and commits (`auth.ts:216`) before
  the client has the new pair; the client keeps the old token on any
  non-401 failure (`api_client.dart:103`); the retry presents a rotated
  token, which `auth.ts:197` treats as theft and revokes the whole family,
  so the user is signed out and must type the password again on the same
  bad network. Fix: a 60-second grace on the server (a `rotated` token
  whose family still has the live child it was rotated to is a retried
  refresh: rotate that child and issue a fresh pair; outside the window or
  with no live child, revoke as today), and on the client retry the same
  refresh token twice with backoff on network errors before giving up.
  Same shape for select-property.
- **No retry layer, no send timeout, multipart retry broken** (medium). The
  only retry is the token-expired path; every transient reset on a
  keep-alive socket surfaces as an error; there is no `sendTimeout`; and the
  401 retry re-sends a finalized `FormData`. Fix: a bounded retry in
  `_call` (GET once; keyed writes up to 3 times on network errors, 5xx and
  429 with jittered backoff and `Retry-After`), `sendTimeout` 30 s (60 s for
  uploads), a body factory for uploads. Server side, add
  `lock_timeout` to the per-transaction settings and map SQLSTATE 55P03 and
  57014 to 503 with `Retry-After`, so a same-key retry that lands while the
  first attempt is still running cannot park a pooled connection forever.
- **Live lists get stuck on an error panel** (medium). `refreshAll()` fires
  at SSE disconnect (while offline) rather than after reconnect
  (`server_events.dart:54-71`), Riverpod then retries each stream 10 times
  in lockstep (~38 s of spinner), and `AsyncBody` replaces data that was on
  screen with "Something went wrong" and no retry (`ui/components.dart:1178`).
  Fix: refetch after a successful connect, `skipError`/`skipLoadingOnReload`
  so the last good data stays visible, a "Try again" action, and a shorter
  jittered retry policy on the `ProviderScope`.

## 7. How this was produced

Seven reviewers each read one angle of the code (request pipeline, SQL and
indexes, transport and caching, security, Flutter call patterns, admin-panel
call patterns, infrastructure) and returned findings with file:line evidence.
Each finding then went to two independent reviewers: one re-read the cited
code to refute the claim, the other judged whether the fix is sound in this
deployment and sharpened it. All 56 findings survived the first check; the
corrections and the sharpened fixes are what this document records. Two
fixes were rejected (response schemas, ETag) and are listed as such. A
completeness reviewer then named the four gap angles in §6; one reviewer
each read those, and their four highest-impact claims were re-checked by
hand against the code. The remaining §6 items carry one reviewer's reading,
so treat their numbers as estimates and re-read the cited lines before
acting on them.
