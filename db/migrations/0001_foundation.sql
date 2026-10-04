-- 0001 · Foundation: tenancy, identity, access, sessions, files, audit.
--
-- Conventions for every migration in this repo (see HANDOVER.md §7):
--   * snake_case everywhere; views are vw_*, functions fn_*.
--   * Ids are bigint identities issued by the server. The apps model every id
--     as an int, and JSON carries them as numbers — safe well past any count
--     a unit will reach.
--   * A date with no time (a work date, a pay period, a shift's effective
--     date) is DATE, sent as "YYYY-MM-DD". An instant is TIMESTAMPTZ, sent as
--     ISO-8601 with a Z. Never store a date as local midnight in a timestamp:
--     that moves the day when read in UTC.
--   * Money is NUMERIC(12,2); a rate is NUMERIC(12,4).
--   * Enumerations are TEXT with a CHECK, holding the Dart enum's *name*
--     exactly ('karigar', 'otherStaff', 'superAdmin' …). Renaming a value is
--     a data migration; reordering the Dart enum is harmless.
--   * Every tenant table carries property_id, and every foreign key between
--     tenant tables includes it, so a row can never point into another
--     property.

create extension if not exists citext;
create extension if not exists btree_gist;

-- Keeps updated_at honest on every write, whoever makes it.
create or replace function fn_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

-- A property is one customer's embroidery unit: the tenant. Everything the
-- apps record belongs to exactly one.
create table properties (
  id          bigint generated always as identity primary key,
  -- Short handle for support and URLs, e.g. 'janki-creation'.
  code        citext not null unique
              check (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name        text not null check (length(btrim(name)) between 1 and 120),
  -- "Today" for a property is decided in its own zone: a work date, the
  -- working day after midnight, a shift's effective date.
  timezone    text not null default 'Asia/Kolkata',
  status      text not null default 'active'
              check (status in ('active', 'suspended', 'closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger properties_touch before update on properties
  for each row execute function fn_touch_updated_at();

-- The unit-wide settings the apps kept per device until now. Pay depends on
-- them, so they belong to the property, not to a phone.
create table property_settings (
  property_id                     bigint primary key
                                  references properties (id) on delete cascade,
  business_name                   text not null default '',
  currency_symbol                 text not null default '₹',
  shift_scheme                    text not null default 'dayNight'
                                  check (shift_scheme in ('dayNight', 'threeShift', 'manual')),
  day_start_minute                smallint not null default 480
                                  check (day_start_minute between 0 and 1439),
  no_leave_bonus_amount           numeric(12,2) not null default 0
                                  check (no_leave_bonus_amount >= 0),
  stitch_based_enabled            boolean not null default false,
  stitch_based_rate_per_thousand  numeric(12,4) not null default 0
                                  check (stitch_based_rate_per_thousand >= 0),
  updated_at                      timestamptz not null default now()
);
create trigger property_settings_touch before update on property_settings
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- A person who can sign in. Global rather than per property, so one owner
-- running two units is one login with two memberships.
create table users (
  id                    bigint generated always as identity primary key,
  display_name          text not null check (length(btrim(display_name)) between 1 and 80),
  -- Any one of these signs in; at least one must be set. See HANDOVER.md §5
  -- for why phone is the one the floor will actually use.
  username              citext unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  phone                 text unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),  -- E.164
  email                 citext unique check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- argon2id. Null until the first password is set (an invite).
  password_hash         text,
  -- A temporary password — set by the owner or by our support — must be
  -- replaced at the next sign-in. The apps already hold such a session on a
  -- "choose your own password" screen.
  must_change_password  boolean not null default true,
  status                text not null default 'active'
                        check (status in ('active', 'disabled')),
  last_login_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (username is not null or phone is not null or email is not null)
);
create trigger users_touch before update on users
  for each row execute function fn_touch_updated_at();

-- Our own staff, who run the web admin panel. Not members of any property:
-- they manage properties from outside them.
create table platform_staff (
  user_id     bigint primary key references users (id) on delete cascade,
  -- admin: everything in the console. support: find a user, reset a
  -- password, read the audit log — nothing that changes a property.
  role        text not null check (role in ('admin', 'support')),
  created_at  timestamptz not null default now(),
  created_by  bigint references users (id)
);

-- A user's place in a property: which role, and whether they own it.
create table property_members (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  user_id               bigint not null references users (id) on delete restrict,
  -- The five roles the apps already gate on (UserRole in sf_core). Fixed for
  -- now; see HANDOVER.md §6 for how custom roles would slot in later.
  role                  text not null
                        check (role in ('superAdmin', 'admin', 'viewAdmin', 'supervisor', 'worker')),
  -- The property's main super admin. Exactly one per property (the index
  -- below allows at most one; creating a property creates it). Only the
  -- owner makes or removes other super admins, and ownership moves only by
  -- an explicit transfer.
  is_owner              boolean not null default false,
  -- The roster row this login is, for a supervisor or an operator who also
  -- appears on slips. Foreign key added with the staff table in 0002.
  staff_id              bigint,
  status                text not null default 'active'
                        check (status in ('active', 'disabled')),
  created_by_member_id  bigint references property_members (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (property_id, user_id),
  unique (property_id, id),
  check (not is_owner or role = 'superAdmin')
);
create unique index property_members_one_owner
  on property_members (property_id) where is_owner;
create trigger property_members_touch before update on property_members
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Access: modules, what each role gets by default, and per-member overrides
-- ---------------------------------------------------------------------------

-- A part of the app that can be granted on its own. Seeded in 0005.
create table modules (
  key         text primary key check (key ~ '^[a-z][a-z_]*$'),
  name        text not null,
  sort_order  smallint not null
);

-- What each fixed role gets per module, and the most it can ever be given.
--
-- level is the default a new member starts with. max_level is the ceiling a
-- member's own grant can reach: a view admin is view-only however modules are
-- ticked, and a supervisor is never shown pay. Selecting modules for a sub
-- user moves them between none and their role's ceiling, nowhere else.
create table role_module_defaults (
  role       text not null
             check (role in ('superAdmin', 'admin', 'viewAdmin', 'supervisor', 'worker')),
  module     text not null references modules (key),
  level      text not null check (level in ('none', 'view', 'edit')),
  max_level  text not null check (max_level in ('none', 'view', 'edit')),
  primary key (role, module),
  check (array_position(array['none', 'view', 'edit'], level)
         <= array_position(array['none', 'view', 'edit'], max_level))
);

-- A sub user's selected modules: overrides of the role default, for one
-- member. Granting never goes above what the granter has themselves — the
-- API enforces that; the table records who granted what.
create table member_module_access (
  member_id             bigint not null references property_members (id) on delete cascade,
  module                text not null references modules (key),
  level                 text not null check (level in ('none', 'view', 'edit')),
  granted_by_member_id  bigint references property_members (id),
  granted_at            timestamptz not null default now(),
  primary key (member_id, module)
);

-- Every action the API performs, the module it belongs to, the level it
-- needs, and whether it is destructive. Destructive means super admin only,
-- whatever the module level says. Seeded in 0005.
create table actions (
  key          text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  module       text not null references modules (key),
  min_level    text not null check (min_level in ('view', 'edit')),
  destructive  boolean not null default false,
  -- Narrower still: only the property's main super admin. Transferring the
  -- property, making or removing a super admin, wiping the unit's data.
  owner_only   boolean not null default false,
  description  text not null,
  check (not owner_only or destructive)
);

-- Which roles a member of a given role may create (and so manage). The
-- owner may also create super admins; that is decided by is_owner, not here.
create table role_can_create (
  creator_role  text not null
                check (creator_role in ('superAdmin', 'admin', 'viewAdmin', 'supervisor', 'worker')),
  created_role  text not null
                check (created_role in ('admin', 'viewAdmin', 'supervisor', 'worker')),
  primary key (creator_role, created_role)
);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

-- One signed-in device. The access token (a short-lived JWT) is never
-- stored; the refresh token is, hashed. Refreshing rotates it within the
-- same family, and presenting a token already rotated away revokes the
-- whole family — a stolen token then stops working for everyone.
create table auth_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             bigint not null references users (id) on delete cascade,
  -- The property the session is acting in. Null for the web admin panel,
  -- whose sessions belong to platform staff, not to a property.
  member_id           bigint references property_members (id) on delete cascade,
  client              text not null check (client in ('managerApp', 'crewApp', 'webAdmin')),
  refresh_token_hash  text not null unique,
  family_id           uuid not null,
  -- 7 days, or 15 with "keep me signed in".
  keep_signed_in      boolean not null default false,
  device_label        text,
  created_at          timestamptz not null default now(),
  last_used_at        timestamptz,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  revoked_reason      text
);
create index auth_sessions_user_live on auth_sessions (user_id) where revoked_at is null;
create index auth_sessions_family on auth_sessions (family_id);

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------

-- Photos of machines, people and machine reports. The bytes live in object
-- storage under storage_key; rows point at a file by id.
create table files (
  id                    uuid primary key default gen_random_uuid(),
  property_id           bigint not null references properties (id) on delete cascade,
  purpose               text not null check (purpose in ('machinePhoto', 'staffPhoto', 'slipPhoto')),
  storage_key           text not null unique,
  content_type          text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size             integer not null check (byte_size between 1 and 15728640),
  sha256                text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width                 integer check (width > 0),
  height                integer check (height > 0),
  created_by_member_id  bigint references property_members (id),
  created_at            timestamptz not null default now(),
  unique (property_id, id)
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Who did what. Every destructive action is written here, as is everything
-- the web admin panel does to a property.
create table audit_log (
  id                    bigint generated always as identity primary key,
  occurred_at           timestamptz not null default now(),
  -- Null for a platform-level action that touches no one property.
  property_id           bigint references properties (id) on delete cascade,
  actor_user_id         bigint references users (id),
  actor_member_id       bigint references property_members (id),
  actor_platform_role   text check (actor_platform_role in ('admin', 'support')),
  action                text not null,   -- an actions.key, or 'platform.*'
  entity_type           text not null,
  entity_id             text,
  destructive           boolean not null default false,
  before                jsonb,
  after                 jsonb,
  request_id            text,
  ip                    inet,
  user_agent            text
);
create index audit_log_property_time on audit_log (property_id, occurred_at desc);
create index audit_log_actor_time on audit_log (actor_user_id, occurred_at desc);
