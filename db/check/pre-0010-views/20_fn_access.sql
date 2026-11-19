-- Access: what a member may see and do.
--
-- The one place the permission rule is written down, so the API, the web
-- admin panel and a hand-run support query cannot disagree. Everything here
-- is `create or replace`, re-applied after the migrations on every deploy.

-- none < view < edit.
create or replace function fn_level_rank(p_level text) returns int
language sql immutable as $$
  select array_position(array['none', 'view', 'edit'], p_level)
$$;

-- A member's level on a module: their own grant if they have one, else
-- their role's default — never above the role's ceiling. The owner is never
-- restricted.
create or replace function fn_member_level(p_member_id bigint, p_module text)
returns text
language sql stable as $$
  select case
    when m.is_owner then 'edit'
    else (array['none', 'view', 'edit'])[
      least(fn_level_rank(coalesce(g.level, d.level)), fn_level_rank(d.max_level))]
  end
  from property_members m
  join role_module_defaults d on d.role = m.role and d.module = p_module
  left join member_module_access g on g.member_id = m.id and g.module = p_module
  where m.id = p_member_id
$$;

-- Every module for every active member, with the level that applies. What
-- the apps receive as the session's module list, and what the web admin
-- panel shows.
create or replace view vw_member_access with (security_invoker = true) as
select
  m.id           as member_id,
  m.property_id,
  m.user_id,
  m.role,
  m.is_owner,
  mo.key         as module,
  mo.sort_order,
  case
    when m.is_owner then 'edit'
    else (array['none', 'view', 'edit'])[
      least(fn_level_rank(coalesce(g.level, d.level)), fn_level_rank(d.max_level))]
  end            as level,
  d.max_level    as ceiling,
  (g.level is not null) as granted_individually
from property_members m
cross join modules mo
join role_module_defaults d on d.role = m.role and d.module = mo.key
left join member_module_access g on g.member_id = m.id and g.module = mo.key
where m.status = 'active';

-- Whether a member may perform an action, e.g. fn_member_can(7, 'machines.delete').
--
--   * The member, their login and their property must all be active.
--   * An owner-only action needs the owner.
--   * A destructive action needs a super admin — whatever the module level.
--   * Anything else needs the action's level on its module.
create or replace function fn_member_can(p_member_id bigint, p_action text)
returns boolean
language sql stable as $$
  select coalesce((
    select case
      when m.status <> 'active' or u.status <> 'active' or p.status <> 'active' then false
      when a.owner_only then m.is_owner
      when a.destructive then m.role = 'superAdmin'
      else fn_level_rank(fn_member_level(m.id, a.module)) >= fn_level_rank(a.min_level)
    end
    from property_members m
    join users u on u.id = m.user_id
    join properties p on p.id = m.property_id
    join actions a on a.key = p_action
    where m.id = p_member_id
  ), false)
$$;

-- Whether a member may create — and so manage — a member of p_role.
-- Only the owner makes super admins.
create or replace function fn_member_can_create(p_member_id bigint, p_role text)
returns boolean
language sql stable as $$
  select coalesce((
    select case
      when not fn_member_can(m.id, 'users.create') then false
      when p_role = 'superAdmin' then m.is_owner
      else exists (select 1 from role_can_create r
                   where r.creator_role = m.role and r.created_role = p_role)
    end
    from property_members m
    where m.id = p_member_id
  ), false)
$$;

-- Whether a grant of p_level on p_module is within what the granter has and
-- within the grantee's role ceiling. Sub users get selected modules, never
-- more than the person who selected them.
create or replace function fn_can_grant(
  p_granter_member_id bigint,
  p_grantee_role text,
  p_module text,
  p_level text
) returns boolean
language sql stable as $$
  select fn_level_rank(p_level) <= fn_level_rank(fn_member_level(p_granter_member_id, p_module))
     and fn_level_rank(p_level) <= (
           select fn_level_rank(d.max_level) from role_module_defaults d
           where d.role = p_grantee_role and d.module = p_module)
$$;

-- The properties a user belongs to, for sign-in and the property switcher.
--
-- Security definer because it runs before a property is chosen, when
-- row-level security would hide every membership. It returns only the
-- caller-named user's own memberships and nothing else.
create or replace function fn_user_memberships(p_user_id bigint)
returns table (
  member_id      bigint,
  property_id    bigint,
  property_code  text,
  property_name  text,
  property_status text,
  role           text,
  is_owner       boolean,
  status         text
)
language sql stable security definer set search_path = public as $$
  select m.id, p.id, p.code::text, p.name, p.status, m.role, m.is_owner, m.status
  from property_members m
  join properties p on p.id = m.property_id
  where m.user_id = p_user_id
  order by p.name
$$;

-- It runs as its owner and takes any user id, so only the API's own roles
-- may call it: not PUBLIC, which on Supabase includes the anonymous REST role.
revoke execute on function fn_user_memberships(bigint) from public;
grant execute on function fn_user_memberships(bigint) to stitchflow_api, stitchflow_platform;
