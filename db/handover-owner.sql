-- One-off for a database made before the hwp_owner role existed: its tables belong to whoever
-- created them (usually the postgres superuser the old server connected as). Hands every table,
-- sequence and function in the public schema to hwp_owner, so that hwp_owner can run migrations
-- (node server.js migrate) and the server can run as hwp_app, which owns nothing.
-- Run once, as an administrator, connected to the application's database:
--   psql -d wealth_profiler -f db/handover-owner.sql
-- Changes ownership only; no data is touched. Not a migration: it is not tracked and may be re-run.
do $$
declare r record;
begin
  if not exists (select from pg_roles where rolname = 'hwp_owner') then
    raise exception 'create the hwp_owner role first (see README)';
  end if;
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I owner to hwp_owner', r.tablename);
  end loop;
  for r in select sequencename from pg_sequences where schemaname = 'public' loop
    execute format('alter sequence public.%I owner to hwp_owner', r.sequencename);
  end loop;
  for r in select p.proname, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    execute format('alter function public.%I(%s) owner to hwp_owner', r.proname, r.args);
  end loop;
end $$;
grant usage on schema public to hwp_owner, hwp_app;
grant create on schema public to hwp_owner;
