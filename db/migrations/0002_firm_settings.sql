-- Firm settings (firm details, team, providers, fund library) for the self-hosted server: one record
-- for the firm, versioned and audited like a household. The same text the file store writes
-- (households/firm/...): JSON, or "enc:v1:..." when DATA_KEY is set.
-- As for households: versions and audit entries can never be changed or deleted, and the firm's
-- record cannot be deleted; only its current row is updated when a new version is saved.

create table if not exists firm_settings (
  id         boolean primary key default true check (id), -- at most one row: the firm
  version    int  not null check (version > 0),
  doc        text not null,
  updated_at timestamptz not null
);

create table if not exists firm_versions (
  version  int  primary key check (version > 0),
  doc      text not null,
  saved_at timestamptz not null default now()
);

create table if not exists firm_audit (
  id    bigint generated always as identity primary key,
  entry text not null
);

create or replace trigger firm_settings_no_delete before delete on firm_settings for each row execute function refuse_change();
create or replace trigger firm_versions_frozen before update or delete on firm_versions for each row execute function refuse_change();
create or replace trigger firm_audit_frozen before update or delete on firm_audit for each row execute function refuse_change();
create or replace trigger firm_settings_no_truncate before truncate on firm_settings execute function refuse_change();
create or replace trigger firm_versions_no_truncate before truncate on firm_versions execute function refuse_change();
create or replace trigger firm_audit_no_truncate before truncate on firm_audit execute function refuse_change();
