-- 0005 · A machine limit for every property.
--
-- A property may hold at most `machine_limit` machines. We set it, from the
-- web admin panel; the unit cannot change it. Every machine that is not in
-- the recycle bin counts, active or not:
--
--   switching a machine off     frees nothing
--   deleting it                 frees its place
--   restoring it from the bin   takes a place again, and is refused if none is left
--
-- Lowering the limit below what a property already has is allowed. Nothing
-- is removed; nothing more can be added or restored until it is under again.
-- vw_machine_allowance (db/views) reads the same count for the API.

alter table properties
  add column machine_limit integer check (machine_limit between 0 and 9999);
-- A property that already exists keeps exactly what it has, until we set it.
update properties p
   set machine_limit = (select count(*) from machines m
                         where m.property_id = p.id and m.deleted_at is null);
alter table properties alter column machine_limit set not null;

create function fn_machines_within_limit() returns trigger
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

create trigger machines_within_limit
  before insert on machines
  for each row execute function fn_machines_within_limit();
create trigger machines_within_limit_on_restore
  before update of deleted_at on machines
  for each row when (old.deleted_at is not null and new.deleted_at is null)
  execute function fn_machines_within_limit();

-- The apps' API changes nothing on the property row. Its name, zone, status
-- and machine limit are ours, set from the web admin panel.
revoke update on properties from stitchflow_api;
drop policy own_property_update on properties;
