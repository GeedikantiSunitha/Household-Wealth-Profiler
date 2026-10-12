-- Tenancy: several firms in one database, each unable to see the others, enforced here by
-- row-level security so that it holds even if application code has a bug.
--
-- Additive only. Every existing row goes to the default firm (the one firm the database held
-- until now). firm_id stays nullable in this migration; it becomes NOT NULL in a later one, once
-- counts have been checked on the real database. The old single-row firm_settings and firm_versions
-- tables are superseded by per-firm firm_records and firm_record_versions (their primary keys
-- allowed one firm only and nothing here may be dropped); their rows are copied, not moved.
--
-- Roles: hwp_owner runs migrations and owns the tables; hwp_app runs the server and may neither
-- bypass row-level security nor delete anything the retention rules protect. Both are created
-- here without a login; the deployment gives them passwords (see README).
--
-- Every policy reads the firm from the transaction-local setting app.firm_id, which the server
-- sets at the start of every transaction. With no setting (null, or the empty string a session
-- is left with after the transaction ends) the comparison is null, so nothing matches: a missing
-- firm fails closed.

create table if not exists firms (
  id          uuid primary key,
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'suspended')),
  seats       int  not null default 5 check (seats >= 0),
  wrapped_key text,                   -- the firm's data key wrapped by DATA_KEY; set by the server on first use
  created_at  timestamptz not null default now()
);
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  name       text not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists memberships (
  user_id    uuid not null references users (id),
  firm_id    uuid not null references firms (id),
  role       text not null default 'adviser' check (role in ('admin', 'adviser', 'compliance')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, firm_id)
);

alter table households add column if not exists firm_id uuid references firms (id);
alter table households add column if not exists reference_hmac text;  -- keyed hash of the normalised client reference
alter table household_versions add column if not exists firm_id uuid references firms (id);
alter table audit_log add column if not exists firm_id uuid references firms (id);
alter table firm_audit add column if not exists firm_id uuid references firms (id);
alter table idempotency_keys add column if not exists firm_id uuid references firms (id);
create index if not exists households_firm on households (firm_id);
create index if not exists households_reference on households (firm_id, reference_hmac);
create index if not exists household_versions_firm on household_versions (firm_id, household_id);
create index if not exists audit_log_firm on audit_log (firm_id, household_id, id desc);
create index if not exists firm_audit_firm on firm_audit (firm_id, id desc);

create table if not exists firm_records (
  firm_id    uuid primary key references firms (id),
  version    int  not null check (version > 0),
  doc        text not null,
  updated_at timestamptz not null
);
create table if not exists firm_record_versions (
  firm_id  uuid not null references firms (id),
  version  int  not null,
  doc      text not null,
  saved_at timestamptz not null default now(),
  primary key (firm_id, version)
);

/* ---------- retention: the one change ever allowed on a frozen row is a firm_id filled in where there was none ---------- */
create or replace function refuse_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (to_jsonb(old) ? 'firm_id') and (to_jsonb(old) ->> 'firm_id') is null and (to_jsonb(new) ->> 'firm_id') is not null
     and (to_jsonb(old) - 'firm_id') = (to_jsonb(new) - 'firm_id') then
    return new;
  end if;
  raise exception '% on % is not allowed: records are kept for regulatory retention', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
create or replace trigger firm_records_no_delete before delete on firm_records for each row execute function refuse_change();
create or replace trigger firm_records_no_truncate before truncate on firm_records execute function refuse_change();
create or replace trigger firm_record_versions_frozen before update or delete on firm_record_versions for each row execute function refuse_change();
create or replace trigger firm_record_versions_no_truncate before truncate on firm_record_versions execute function refuse_change();

/* ---------- the default firm, and every existing row into it ---------- */
insert into firms (id, name) values ('f1a00000-0000-4000-8000-000000000001', 'Default firm') on conflict (id) do nothing;
update households set firm_id = 'f1a00000-0000-4000-8000-000000000001' where firm_id is null;
update household_versions set firm_id = 'f1a00000-0000-4000-8000-000000000001' where firm_id is null;
update audit_log set firm_id = 'f1a00000-0000-4000-8000-000000000001' where firm_id is null;
update firm_audit set firm_id = 'f1a00000-0000-4000-8000-000000000001' where firm_id is null;
update idempotency_keys set firm_id = 'f1a00000-0000-4000-8000-000000000001' where firm_id is null;
insert into firm_records (firm_id, version, doc, updated_at)
  select 'f1a00000-0000-4000-8000-000000000001', version, doc, updated_at from firm_settings on conflict (firm_id) do nothing;
insert into firm_record_versions (firm_id, version, doc, saved_at)
  select 'f1a00000-0000-4000-8000-000000000001', version, doc, saved_at from firm_versions on conflict do nothing;

/* ---------- roles ---------- */
do $$ begin
  if not exists (select from pg_roles where rolname = 'hwp_owner') then create role hwp_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole; end if;
  if not exists (select from pg_roles where rolname = 'hwp_app') then create role hwp_app nologin nosuperuser nobypassrls nocreatedb nocreaterole; end if;
  execute format('grant usage on schema %I to hwp_app', current_schema());
  execute format('grant usage, select on all sequences in schema %I to hwp_app', current_schema());
end $$;
grant select, insert, update on households to hwp_app;
grant select, insert on household_versions, audit_log, firm_record_versions, firm_audit to hwp_app;
grant select, insert, update on firm_records to hwp_app;
grant select, insert, delete on idempotency_keys to hwp_app;
grant select, update (wrapped_key) on firms to hwp_app;
grant select on users, memberships, schema_migrations to hwp_app;

/* ---------- row-level security, forced for every role, including the owner ---------- */
do $$
declare t text;
begin
  foreach t in array array['households', 'household_versions', 'audit_log', 'firm_records', 'firm_record_versions', 'firm_audit', 'idempotency_keys'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select from pg_policies where tablename = t and policyname = 'firm_rows') then
      execute format('create policy firm_rows on %I to hwp_app using (firm_id = nullif(current_setting(''app.firm_id'', true), '''')::uuid) with check (firm_id = nullif(current_setting(''app.firm_id'', true), '''')::uuid)', t);
    end if;
  end loop;
  -- firms: a firm sees only its own row; the owner (migrations, operator tooling) manages them all
  foreach t in array array['firms', 'users', 'memberships'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select from pg_policies where tablename = t and policyname = 'owner_rows') then
      execute format('create policy owner_rows on %I to hwp_owner using (true) with check (true)', t);
    end if;
  end loop;
  if not exists (select from pg_policies where tablename = 'firms' and policyname = 'own_firm') then
    create policy own_firm on firms to hwp_app using (id = nullif(current_setting('app.firm_id', true), '')::uuid);
  end if;
end $$;
