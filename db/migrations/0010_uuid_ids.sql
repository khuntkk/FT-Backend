-- 0010 · Every id becomes a UUID.
--
-- Sequential ids could be walked one by one and told how many of everything
-- there were. Every primary key, and every column that points at one, is now
-- a time-ordered UUID (version 7): 48 bits of milliseconds, 12 bits that keep
-- rows created in the same millisecond in order, 62 random bits. Not
-- guessable, and still in creation order, so "newest first" and the API's
-- cursors keep their meaning.
--
-- Existing rows are converted in place, in this one transaction:
--   * each row's new id is built from its own creation time, so old rows keep
--     exactly the order their numbers gave them;
--   * an old → new map lives in pg_temp for this transaction only and is
--     dropped at commit: nothing links the old numbers to the new ids after;
--   * foreign keys, unique and exclusion constraints, indexes and row-level
--     security policies come back with their names and rules unchanged
--     (checked below before commit);
--   * every session is ended (access tokens carry the old numbers) and the
--     idempotency keys are emptied (their stored replies do too).
-- The audit log's entity_id is remapped where its entity still exists; the
-- before/after snapshots stay as written: history, with the old numbers.
--
-- The views and fn_* functions in db/views are dropped here and re-created by
-- the runner with uuid signatures, in the same transaction (migrate.ts).
-- Columns that are bigint but not ids (stitch counts, totp_last_step) stay.

set local lock_timeout = '10s';
set local statement_timeout = '15min';
set local search_path = public;

-- ---------------------------------------------------------------------------
-- New ids
-- ---------------------------------------------------------------------------

-- RFC 9562 version 7, "method 3": the 12 bits after the version are the
-- fraction of the millisecond. Like Postgres 18's own uuidv7(), it never goes
-- backwards on one connection: ids made one after another, even in the same
-- statement, sort in the order they were made.
create or replace function fn_uuid_v7() returns uuid
language plpgsql volatile as $$
declare
  -- Milliseconds × 4096 + the fraction of the millisecond, in 1/4096ths.
  tick bigint := greatest(
    floor(extract(epoch from clock_timestamp()) * 4096000)::bigint,
    coalesce(nullif(current_setting('stitchflow.uuid_tick', true), '')::bigint, 0) + 1);
begin
  perform set_config('stitchflow.uuid_tick', tick::text, false);
  return encode(
    set_byte(set_byte(
      overlay(uuid_send(gen_random_uuid()) placing substring(int8send(tick >> 12) from 3) from 1 for 6),
      6, (112 | ((tick >> 8) & 15))::int),
      7, (tick & 255)::int),
    'hex')::uuid;
end $$;
grant execute on function fn_uuid_v7() to stitchflow_api, stitchflow_platform;

-- The same layout from a given millisecond and 12-bit counter: for existing rows.
create function pg_temp.uuid_v7_from(p_ms bigint, p_seq int) returns uuid
language sql volatile as $$
  select encode(
    set_byte(set_byte(
      overlay(uuid_send(gen_random_uuid()) placing substring(int8send(p_ms) from 3) from 1 for 6),
      6, 112 | ((p_seq >> 8) & 15)),
      7, p_seq & 255),
    'hex')::uuid
$$;

-- ---------------------------------------------------------------------------
-- What converts, and what is checked afterwards
-- ---------------------------------------------------------------------------

-- Every column that holds an id, and the table whose id it holds.
create temp table id_columns (tbl text, col text, parent text, primary key (tbl, col)) on commit drop;
insert into pg_temp.id_columns values
  ('properties', 'id', 'properties'),
  ('property_settings', 'property_id', 'properties'),
  ('users', 'id', 'users'),
  ('platform_staff', 'user_id', 'users'),
  ('platform_staff', 'created_by', 'users'),
  ('property_members', 'id', 'property_members'),
  ('property_members', 'property_id', 'properties'),
  ('property_members', 'user_id', 'users'),
  ('property_members', 'staff_id', 'staff'),
  ('property_members', 'created_by_member_id', 'property_members'),
  ('member_module_access', 'member_id', 'property_members'),
  ('member_module_access', 'granted_by_member_id', 'property_members'),
  ('auth_sessions', 'user_id', 'users'),
  ('auth_sessions', 'member_id', 'property_members'),
  ('files', 'property_id', 'properties'),
  ('files', 'created_by_member_id', 'property_members'),
  ('audit_log', 'id', 'audit_log'),
  ('audit_log', 'property_id', 'properties'),
  ('audit_log', 'actor_user_id', 'users'),
  ('audit_log', 'actor_member_id', 'property_members'),
  ('machines', 'id', 'machines'),
  ('machines', 'property_id', 'properties'),
  ('staff', 'id', 'staff'),
  ('staff', 'property_id', 'properties'),
  ('shifts', 'id', 'shifts'),
  ('shifts', 'property_id', 'properties'),
  ('shifts', 'lineage_id', 'shifts'),
  ('production_entries', 'id', 'production_entries'),
  ('production_entries', 'property_id', 'properties'),
  ('production_entries', 'machine_id', 'machines'),
  ('production_entries', 'shift_id', 'shifts'),
  ('entry_karigars', 'property_id', 'properties'),
  ('entry_karigars', 'entry_id', 'production_entries'),
  ('entry_karigars', 'staff_id', 'staff'),
  ('attendance_marks', 'id', 'attendance_marks'),
  ('attendance_marks', 'property_id', 'properties'),
  ('attendance_marks', 'staff_id', 'staff'),
  ('advances', 'id', 'advances'),
  ('advances', 'property_id', 'properties'),
  ('advances', 'staff_id', 'staff'),
  ('salary_payments', 'id', 'salary_payments'),
  ('salary_payments', 'property_id', 'properties'),
  ('salary_payments', 'staff_id', 'staff'),
  ('bonus_rules', 'id', 'bonus_rules'),
  ('bonus_rules', 'property_id', 'properties'),
  ('bonus_slabs', 'id', 'bonus_slabs'),
  ('bonus_slabs', 'property_id', 'properties'),
  ('bonus_slabs', 'rule_id', 'bonus_rules'),
  ('slip_scans', 'id', 'slip_scans'),
  ('slip_scans', 'property_id', 'properties'),
  ('slip_scans', 'machine_id', 'machines'),
  ('slip_scans', 'entry_id', 'production_entries'),
  ('idempotency_keys', 'property_id', 'properties'),
  ('idempotency_keys', 'member_id', 'property_members');
-- Who-did-it columns, wherever they exist.
insert into pg_temp.id_columns
select c.table_name, c.column_name, 'property_members'
from information_schema.columns c
where c.table_schema = 'public'
  and c.column_name in ('created_by_member_id', 'updated_by_member_id', 'deleted_by_member_id')
on conflict do nothing;

-- The bigint columns that are not ids and stay bigint.
create temp table not_ids (tbl text, col text) on commit drop;
insert into pg_temp.not_ids values
  ('production_entries', 'total_stitches'), ('production_entries', 'design_stitches'),
  ('salary_payments', 'stitches_in_period'), ('bonus_slabs', 'from_stitches'),
  ('bonus_slabs', 'to_stitches'), ('platform_staff', 'totp_last_step');

-- Every bigint column of these tables must be one or the other.
do $$
declare
  missing text;
begin
  select string_agg(c.table_name || '.' || c.column_name, ', ') into missing
  from information_schema.columns c
  where c.table_schema = 'public' and c.data_type = 'bigint'
    and c.table_name in (select tbl from pg_temp.id_columns)
    and (c.table_name, c.column_name) not in (select tbl, col from pg_temp.id_columns)
    and (c.table_name, c.column_name) not in (select tbl, col from pg_temp.not_ids);
  if missing is not null then
    raise exception '0010: bigint columns neither converted nor kept: %', missing;
  end if;
end $$;

-- What carries the old numbers and cannot be converted: access tokens (so
-- every session ends) and the replies stored against idempotency keys.
update auth_sessions set revoked_at = now(), revoked_reason = 'idsChanged' where revoked_at is null;
delete from idempotency_keys;

-- Before: row counts, foreign keys, indexes and policies, to compare at the end.
create temp table before_counts (tbl text primary key, n bigint) on commit drop;
do $$
declare
  t text;
  n bigint;
begin
  for t in select distinct tbl from pg_temp.id_columns loop
    execute format('select count(*) from %I', t) into n;
    insert into pg_temp.before_counts values (t, n);
  end loop;
end $$;

create temp table saved_fks on commit drop as
select c.conrelid::regclass::text as tbl, c.conname::text as conname, pg_get_constraintdef(c.oid) as def
from pg_constraint c
where c.contype = 'f' and c.connamespace = 'public'::regnamespace
  and c.conrelid::regclass::text in (select tbl from pg_temp.id_columns);

create temp table before_indexes on commit drop as
select tablename::text as tbl, indexname::text as idx
from pg_indexes
where schemaname = 'public' and tablename in (select tbl from pg_temp.id_columns);

create temp table before_policies on commit drop as
select tablename::text as tbl, policyname::text as pol, cmd, roles::text as roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in (select tbl from pg_temp.id_columns);

-- ---------------------------------------------------------------------------
-- Out of the way: views, functions and policies typed on the old ids
-- ---------------------------------------------------------------------------

drop view if exists vw_member_access;
drop view if exists vw_attendance_days;
drop view if exists vw_recycle_bin;
drop view if exists vw_machine_allowance;

-- Exact signatures: a wrong one would do nothing, and the uuid version made
-- next to it would make every untyped call ambiguous. Checked just below.
drop function if exists fn_property_today(bigint);
drop function if exists fn_member_level(bigint, text);
drop function if exists fn_member_can(bigint, text);
drop function if exists fn_member_can_create(bigint, text);
drop function if exists fn_can_grant(bigint, text, text, text);
drop function if exists fn_user_memberships(bigint);
drop function if exists fn_advance_outstanding(bigint, date, date);
drop function if exists fn_payroll_inputs(bigint, date);

do $$
declare
  t text;
begin
  foreach t in array array[
    'property_settings', 'property_members', 'files', 'audit_log',
    'machines', 'staff', 'shifts', 'production_entries', 'entry_karigars',
    'attendance_marks', 'advances', 'salary_payments', 'bonus_rules',
    'bonus_slabs', 'slip_scans', 'member_module_access', 'idempotency_keys']
  loop
    execute format('drop policy if exists tenant_isolation on %I', t);
  end loop;
end $$;
drop policy if exists own_property on properties;

-- Its return type changes, so it is dropped and made again (the policies
-- that call it are gone until the end of this file).
drop function fn_current_property();
create function fn_current_property() returns uuid
language sql stable as $$
  select nullif(current_setting('app.property_id', true), '')::uuid
$$;
grant execute on function fn_current_property() to stitchflow_api, stitchflow_platform;

do $$
declare
  left_over text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into left_over
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and 20::oid = any (p.proargtypes::oid[])
    -- Ours only: citext and btree_gist keep their own bigint functions here.
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
  if left_over is not null then
    raise exception '0010: functions still take a bigint: %', left_over;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The map: old number → new id, in the order the numbers gave
-- ---------------------------------------------------------------------------

create temp table id_map (tbl text, old_id bigint, new_id uuid not null, primary key (tbl, old_id)) on commit drop;

-- tick = milliseconds × 4096 + counter, strictly rising in old-id order and
-- never earlier than the row's own time. Rows written in one transaction share
-- a creation time; the counter keeps them in their old order.
do $$
declare
  r record;
begin
  for r in select * from (values
    ('properties', 't.created_at'), ('users', 't.created_at'),
    ('property_members', 't.created_at'), ('audit_log', 't.occurred_at'),
    ('machines', 't.created_at'), ('staff', 't.created_at'), ('shifts', 't.created_at'),
    ('production_entries', 't.created_at'), ('attendance_marks', 't.created_at'),
    ('advances', 't.created_at'), ('salary_payments', 't.created_at'),
    ('bonus_rules', 't.created_at'), ('slip_scans', 't.created_at'),
    -- Slabs have no time of their own; they are rewritten whenever their rule is saved.
    ('bonus_slabs', '(select b.updated_at from bonus_rules b where b.id = t.rule_id)')
  ) v(tbl, ts)
  loop
    execute format($f$
      insert into pg_temp.id_map (tbl, old_id, new_id)
      select %L, id, pg_temp.uuid_v7_from(tick >> 12, (tick & 4095)::int)
      from (select id, n + max(ms * 4096 - n) over (order by id) as tick
            from (select t.id, row_number() over (order by t.id) - 1 as n,
                         floor(extract(epoch from %s) * 1000)::bigint as ms
                  from %I t) a) b
    $f$, r.tbl, r.ts, r.tbl);
  end loop;
end $$;
analyze pg_temp.id_map;

-- Null stays null; an id with no new one stops the migration.
create function pg_temp.new_id(p_tbl text, p_old bigint) returns uuid
language plpgsql stable strict as $$
declare
  v uuid;
begin
  select m.new_id into v from pg_temp.id_map m where m.tbl = p_tbl and m.old_id = p_old;
  if v is null then
    raise exception '0010: no new id for %.%', p_tbl, p_old;
  end if;
  return v;
end $$;

-- The audit log names its subject by type and number. Where that subject still
-- exists it gets the new id; one deleted for good keeps its number, as history.
update audit_log a
   set entity_id = m.new_id::text
  from pg_temp.id_map m
 where a.entity_id ~ '^[0-9]{1,18}$'
   and m.old_id = a.entity_id::bigint
   and m.tbl = case
     when a.entity_type in ('property', 'properties') then 'properties'
     when a.entity_type in ('user', 'platformStaff') then 'users'
     -- Console routes name users and our staff by user id.
     when a.entity_type in ('users', 'staff') and a.action like 'platform.%' then 'users'
     when a.entity_type in ('member', 'users') then 'property_members'
     when a.entity_type in ('machine', 'machines') then 'machines'
     when a.entity_type = 'staff' then 'staff'
     -- The recycle bin names a cleared month by one of its marks; marking names the person.
     when a.entity_type = 'attendance' and a.action like 'recycle_bin.%' then 'attendance_marks'
     when a.entity_type = 'attendance' then 'staff'
     when a.entity_type in ('productionEntry', 'production') then 'production_entries'
     when a.entity_type in ('upad', 'advance', 'advances') then 'advances'
     when a.entity_type in ('salaryPayment', 'payroll') then 'salary_payments'
     when a.entity_type in ('bonusRule', 'bonus-rules') then 'bonus_rules'
     when a.entity_type in ('shift', 'shifts') then 'shifts'
   end;

-- ---------------------------------------------------------------------------
-- The conversion
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
begin
  for f in select * from pg_temp.saved_fks loop
    execute format('alter table %I drop constraint %I', f.tbl, f.conname);
  end loop;
end $$;

-- One rewrite per table: every id column at once, then the new default.
do $$
declare
  t text;
  stmt text;
begin
  for t in select distinct tbl from pg_temp.id_columns order by tbl loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t
                 and column_name = 'id' and is_identity = 'YES') then
      execute format('alter table %I alter column id drop identity', t);
    end if;
    select 'alter table ' || quote_ident(t) || ' '
           || string_agg(format('alter column %I type uuid using pg_temp.new_id(%L, %I)', col, parent, col), ', ')
           || case when bool_or(col = 'id' and parent = t) then ', alter column id set default fn_uuid_v7()' else '' end
      into stmt
      from pg_temp.id_columns
     where tbl = t;
    execute stmt;
  end loop;
end $$;

do $$
declare
  f record;
begin
  for f in select * from pg_temp.saved_fks loop
    execute format('alter table %I add constraint %I %s', f.tbl, f.conname, f.def);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security back, exactly as 0004 and 0006 wrote it
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'property_settings', 'property_members', 'files', 'audit_log',
    'machines', 'staff', 'shifts', 'production_entries', 'entry_karigars',
    'attendance_marks', 'advances', 'salary_payments', 'bonus_rules',
    'bonus_slabs', 'slip_scans', 'idempotency_keys']
  loop
    execute format(
      'create policy tenant_isolation on %I to stitchflow_api '
      'using (property_id = fn_current_property()) '
      'with check (property_id = fn_current_property())', t);
  end loop;
end $$;
create policy tenant_isolation on member_module_access to stitchflow_api
  using (exists (select 1 from property_members m
                 where m.id = member_id and m.property_id = fn_current_property()))
  with check (exists (select 1 from property_members m
                      where m.id = member_id and m.property_id = fn_current_property()));
-- (own_property_update stays gone: 0005 dropped it on purpose.)
create policy own_property on properties for select to stitchflow_api
  using (id = fn_current_property());

-- Trigger functions compiled against the old column types, made again as
-- they were so no pooled connection keeps a stale copy.
create or replace function fn_shift_first_version_is_own_lineage() returns trigger
language plpgsql as $$
begin
  if new.lineage_id is null then
    new.lineage_id := new.id;
  end if;
  return new;
end $$;

create or replace function fn_machines_within_limit() returns trigger
language plpgsql as $$
declare
  lim  integer;
  used integer;
begin
  -- Two requests adding machines to one property take turns here, so neither
  -- counts before the other has finished (at read committed, the default).
  perform pg_advisory_xact_lock(hashtextextended('machine_limit:' || new.property_id, 0));
  -- Null only when the caller cannot see the property, and row-level
  -- security then refuses the row anyway.
  select machine_limit into lim from properties where id = new.property_id;
  select count(*) into used from machines
   where property_id = new.property_id and deleted_at is null;
  if used >= lim then
    raise exception 'machine limit reached: % of %', used, lim
      using errcode = 'check_violation',
            constraint = 'machine_limit',
            detail = json_build_object('limit', lim, 'used', used)::text;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Checks before commit: anything off rolls the whole migration back
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  n bigint;
  problem text;
begin
  for t in select tbl from pg_temp.before_counts loop
    execute format('select count(*) from %I', t) into n;
    if n <> (select b.n from pg_temp.before_counts b where b.tbl = t) then
      raise exception '0010: % has % rows, had %', t, n, (select b.n from pg_temp.before_counts b where b.tbl = t);
    end if;
  end loop;

  select string_agg(c.tbl || '.' || c.col, ', ') into problem
  from pg_temp.id_columns c
  join information_schema.columns i
    on i.table_schema = 'public' and i.table_name = c.tbl and i.column_name = c.col
  where i.data_type <> 'uuid';
  if problem is not null then raise exception '0010: not uuid: %', problem; end if;

  select string_agg(c.tbl || '.' || c.col, ', ') into problem
  from pg_temp.not_ids c
  join information_schema.columns i
    on i.table_schema = 'public' and i.table_name = c.tbl and i.column_name = c.col
  where i.data_type <> 'bigint';
  if problem is not null then raise exception '0010: should have stayed bigint: %', problem; end if;

  select string_agg(coalesce(b.tbl || '.' || b.conname, a.tbl || '.' || a.conname), ', ') into problem
  from pg_temp.saved_fks b
  full join (select c.conrelid::regclass::text as tbl, c.conname::text as conname, pg_get_constraintdef(c.oid) as def
             from pg_constraint c
             where c.contype = 'f' and c.connamespace = 'public'::regnamespace
               and c.conrelid::regclass::text in (select tbl from pg_temp.id_columns)) a
    on a.tbl = b.tbl and a.conname = b.conname and a.def = b.def
  where a.conname is null or b.conname is null;
  if problem is not null then raise exception '0010: foreign keys differ: %', problem; end if;

  select string_agg(coalesce(b.tbl || '.' || b.idx, a.tbl || '.' || a.idx), ', ') into problem
  from pg_temp.before_indexes b
  full join (select tablename::text as tbl, indexname::text as idx from pg_indexes
             where schemaname = 'public' and tablename in (select tbl from pg_temp.id_columns)) a
    on a.tbl = b.tbl and a.idx = b.idx
  where a.idx is null or b.idx is null;
  if problem is not null then raise exception '0010: indexes differ: %', problem; end if;

  select string_agg(coalesce(b.tbl || '.' || b.pol, a.tbl || '.' || a.pol), ', ') into problem
  from pg_temp.before_policies b
  full join (select tablename::text as tbl, policyname::text as pol, cmd, roles::text as roles, qual, with_check
             from pg_policies
             where schemaname = 'public' and tablename in (select tbl from pg_temp.id_columns)) a
    on a.tbl = b.tbl and a.pol = b.pol and a.cmd = b.cmd and a.roles = b.roles
   and a.qual is not distinct from b.qual and a.with_check is not distinct from b.with_check
  where a.pol is null or b.pol is null;
  if problem is not null then raise exception '0010: policies differ: %', problem; end if;
end $$;

-- Temporary functions outlive the commit on a pooled connection; the tables
-- go with it (on commit drop).
drop function pg_temp.new_id(text, bigint);
drop function pg_temp.uuid_v7_from(bigint, int);

-- Changing a column's type drops its planner statistics.
do $$
declare
  t text;
begin
  for t in select distinct tbl from pg_temp.id_columns loop
    execute format('analyze %I', t);
  end loop;
end $$;
