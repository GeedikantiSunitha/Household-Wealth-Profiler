-- Household Wealth Profiler: PostgreSQL storage for the self-hosted server (server.js).
-- Applied at start-up by db/migrate.js when DATABASE_URL is set. Written with "if not exists" so it
-- also adopts databases created before migrations were tracked, without touching their rows.
-- Each doc / entry column holds the same text the file store writes: JSON, or "enc:v1:..."
-- (AES-256-GCM) when DATA_KEY is set, so client data stays encrypted inside the database too.
-- Versions and the audit log can never be changed or deleted, and households cannot be deleted
-- (Money Laundering Regulations: keep records 5 years after the relationship ends).

create table if not exists households (
  id         uuid primary key,
  version    int  not null check (version > 0),
  doc        text not null,
  updated_at timestamptz not null
);
create index if not exists households_updated on households (updated_at desc);

create table if not exists household_versions (
  household_id uuid not null references households (id),
  version      int  not null,
  doc          text not null,
  saved_at     timestamptz not null default now(),
  primary key (household_id, version)
);

create table if not exists audit_log (
  id           bigint generated always as identity primary key,
  household_id uuid not null references households (id),
  entry        text not null
);
create index if not exists audit_household on audit_log (household_id, id desc);

/* ---------- retention: nothing is ever deleted or rewritten ---------- */
create or replace function refuse_change() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: records are kept for regulatory retention', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
create or replace trigger households_no_delete before delete on households for each row execute function refuse_change();
create or replace trigger versions_frozen before update or delete on household_versions for each row execute function refuse_change();
create or replace trigger audit_frozen before update or delete on audit_log for each row execute function refuse_change();
create or replace trigger households_no_truncate before truncate on households execute function refuse_change();
create or replace trigger versions_no_truncate before truncate on household_versions execute function refuse_change();
create or replace trigger audit_no_truncate before truncate on audit_log execute function refuse_change();
