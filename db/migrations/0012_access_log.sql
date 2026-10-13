-- Phase 4: who looked at which client file. The change audit (audit_log) records what was saved;
-- this records reads: the client list, opening a household, its audit trail, an export from the
-- browser (Excel, JSON, print), a subject access export, the records and retention page, and every
-- refused attempt (an id that is not in the firm, an action the role may not take).
--
-- No client data is kept here: who, when, what action, which household id, the outcome and a short
-- detail (an export's kind, how many rows a list showed). An entry outlives a purged household, so
-- household_id has no foreign key: after a purge it names a household that no longer exists, which
-- is what the purge register (migration 0013) records.
--
-- Entries are kept as the audit log is: no update, delete or truncate, by anyone. Row-level
-- security is forced: the app role reads and adds entries for the firm set on its transaction
-- only; the owner reads every firm's (the operator's account subject access export).

create table if not exists access_log (
  id           bigint generated always as identity primary key,
  firm_id      uuid not null references firms (id),
  at           timestamptz not null default now(),
  actor        text not null,                    -- the signed-in user: the account's email, or the Basic name in development
  user_id      uuid references users (id),       -- the account, with the app's own sign-in; null with Basic sign-in
  action       text not null check (action ~ '^[a-z_]{1,40}$'),  -- list, read, audit, access_log, export, subject_access, records, ...
  household_id uuid,                             -- null for a firm-wide action (the client list)
  outcome      text not null default 'ok' check (outcome in ('ok', 'not_found', 'forbidden')),
  detail       text not null default '' check (length(detail) <= 200)
);
create index if not exists access_log_household on access_log (firm_id, household_id, id desc);
create index if not exists access_log_firm_at on access_log (firm_id, at desc);
create index if not exists access_log_user on access_log (user_id, at);

create or replace trigger access_log_frozen before update or delete on access_log for each row execute function refuse_change();
create or replace trigger access_log_no_truncate before truncate on access_log execute function refuse_change();

grant select, insert on access_log to hwp_app;
do $$ begin
  execute format('grant usage, select on all sequences in schema %I to hwp_app', current_schema());
end $$;

alter table access_log enable row level security;
alter table access_log force row level security;
do $$ begin
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'access_log' and policyname = 'firm_rows') then
    create policy firm_rows on access_log to hwp_app
      using (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid)
      with check (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
  end if;
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'access_log' and policyname = 'owner_reads') then
    create policy owner_reads on access_log for select to hwp_owner using (true);
  end if;
end $$;
