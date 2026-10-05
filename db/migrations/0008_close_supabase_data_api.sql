-- 0008 · Nothing reachable through Supabase's Data API.
--
-- Supabase serves the public schema over REST (PostgREST) to its `anon` and
-- `authenticated` roles, and its default privileges grant them every table,
-- sequence and function created here. The anon key is public by design, so
-- without this anyone holding it could read `users` (password hashes) and
-- `auth_sessions`, which have no row-level security. StitchFlow does not use
-- the Data API: the API connects as its own roles. On plain Postgres these
-- roles do not exist and this does nothing.

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
