-- 0004 · Security: database roles and row-level security.
--
-- The API checks permissions itself (fn_member_can). This is the second lock,
-- behind the first: a query that forgets its property filter, or a bug in
-- the checks, still cannot reach another property's rows.
--
-- Two group roles, no passwords. Deployment creates the login roles and
-- grants these to them (HANDOVER.md §13):
--   stitchflow_api       the apps' API. Sees one property per transaction,
--                        the one in app.property_id, which the API sets with
--                          set local app.property_id = '<id>';
--                        at the start of every request's transaction. Unset
--                        means no rows at all — it fails closed.
--   stitchflow_platform  the web admin panel's API. Sees every property,
--                        because managing them is its job; everything it
--                        changes is written to audit_log.
-- Migrations run as the schema owner, which row-level security does not
-- restrict.

do $$
begin
  if not exists (select from pg_roles where rolname = 'stitchflow_api') then
    create role stitchflow_api nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'stitchflow_platform') then
    create role stitchflow_platform nologin;
  end if;
end $$;

-- The property the current transaction acts for, or null.
create or replace function fn_current_property() returns bigint
language sql stable as $$
  select nullif(current_setting('app.property_id', true), '')::bigint
$$;

grant usage on schema public to stitchflow_api, stitchflow_platform;
grant select, insert, update, delete on all tables in schema public
  to stitchflow_api, stitchflow_platform;
grant usage, select on all sequences in schema public
  to stitchflow_api, stitchflow_platform;
grant execute on all functions in schema public
  to stitchflow_api, stitchflow_platform;
alter default privileges in schema public
  grant select, insert, update, delete on tables to stitchflow_api, stitchflow_platform;
alter default privileges in schema public
  grant usage, select on sequences to stitchflow_api, stitchflow_platform;
alter default privileges in schema public
  grant execute on functions to stitchflow_api, stitchflow_platform;

-- The access catalog changes only through migrations.
revoke insert, update, delete on modules, role_module_defaults, role_can_create, actions
  from stitchflow_api, stitchflow_platform;

-- The audit log is append-only for everyone the API connects as.
revoke update, delete on audit_log from stitchflow_api, stitchflow_platform;

-- The apps' API never creates properties or platform staff; the web admin
-- panel does.
revoke insert, delete on properties, platform_staff from stitchflow_api;
revoke update on platform_staff from stitchflow_api;

-- Every table that belongs to a property.
do $$
declare
  t text;
begin
  foreach t in array array[
    'property_settings', 'property_members', 'files', 'audit_log',
    'machines', 'staff', 'shifts', 'production_entries', 'entry_karigars',
    'attendance_marks', 'advances', 'salary_payments', 'bonus_rules',
    'bonus_slabs', 'slip_scans']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I to stitchflow_api '
      'using (property_id = fn_current_property()) '
      'with check (property_id = fn_current_property())', t);
    execute format(
      'create policy platform_all on %I to stitchflow_platform '
      'using (true) with check (true)', t);
  end loop;
end $$;

-- A member's module grants carry no property_id of their own.
alter table member_module_access enable row level security;
create policy tenant_isolation on member_module_access to stitchflow_api
  using (exists (select 1 from property_members m
                 where m.id = member_id and m.property_id = fn_current_property()))
  with check (exists (select 1 from property_members m
                      where m.id = member_id and m.property_id = fn_current_property()));
create policy platform_all on member_module_access to stitchflow_platform
  using (true) with check (true);

-- The API may read its own property row and no other.
alter table properties enable row level security;
create policy own_property on properties for select to stitchflow_api
  using (id = fn_current_property());
create policy own_property_update on properties for update to stitchflow_api
  using (id = fn_current_property()) with check (id = fn_current_property());
create policy platform_all on properties to stitchflow_platform
  using (true) with check (true);
