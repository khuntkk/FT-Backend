-- 0006 · Idempotency keys.
--
-- The apps send an Idempotency-Key with every create, one per user action,
-- so a request retried on a weak connection never records twice (API.md §1).
-- The first response is kept here for 24 hours and returned to any repeat.
-- The purge job removes older keys.
--
-- The row is inserted at the start of the request's transaction, before the
-- work. A repeat arriving while the first is still running waits on the
-- primary key, then reads the response the first one stored — or, if the
-- first rolled back, does the work itself.

create table idempotency_keys (
  property_id  bigint not null references properties (id) on delete cascade,
  member_id    bigint not null,
  key          text not null check (length(key) between 8 and 100),
  -- "METHOD /path" of the route: the same key on another route is a client bug.
  route        text not null,
  status_code  smallint,
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (member_id, key),
  foreign key (property_id, member_id) references property_members (property_id, id) on delete cascade
);
create index idempotency_keys_created on idempotency_keys (created_at);

alter table idempotency_keys enable row level security;
create policy tenant_isolation on idempotency_keys to stitchflow_api
  using (property_id = fn_current_property())
  with check (property_id = fn_current_property());
create policy platform_all on idempotency_keys to stitchflow_platform
  using (true) with check (true);
