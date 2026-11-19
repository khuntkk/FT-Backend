-- How many machines each property may have, has, and has left — for the
-- apps' "Add machine" and the web admin panel's property list. It counts
-- what fn_machines_within_limit (0005) counts: every machine not in the bin.

create or replace view vw_machine_allowance with (security_invoker = true) as
select
  p.id                                               as property_id,
  p.machine_limit,
  count(m.id)::int                                   as machines_used,
  greatest(p.machine_limit - count(m.id), 0)::int    as machines_left
from properties p
left join machines m on m.property_id = p.id and m.deleted_at is null
group by p.id;
