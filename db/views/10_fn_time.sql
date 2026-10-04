-- Time, as a property sees it.
--
-- "Today" is the property's own date, not the server's: a server in UTC
-- would roll an Indian unit's day over at 5:30 in the morning. The shift
-- rules (a change waits for tomorrow once today has slips; the working day
-- after midnight is still yesterday on a night shift) all start from this.

create or replace function fn_property_today(p_property_id bigint) returns date
language sql stable as $$
  select (now() at time zone p.timezone)::date
  from properties p
  where p.id = p_property_id
$$;
