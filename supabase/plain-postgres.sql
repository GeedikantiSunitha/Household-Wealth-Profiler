-- Stand-ins for what a Supabase project already has, so supabase/migrations also apply to a
-- plain PostgreSQL 14+ database. scripts/supabase-db.js runs this only when the database has no
-- auth.users table, so a real or self-hosted Supabase project is never touched by it.
-- The first run needs a superuser (it creates roles, and service_role bypasses row level security
-- as it does on Supabase). Nothing here drops or replaces existing objects except auth.uid().

do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);
-- On Supabase this reads the signed-in user from the request's token; here it reads the same setting
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth, public to anon, authenticated, service_role;
grant references, select on auth.users to service_role;
