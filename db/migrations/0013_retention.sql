-- Phase 4: the retention clock and approved purge.
--
-- The Money Laundering Regulations 2017 (regulation 40) require a firm to keep customer due
-- diligence records for five years after the business relationship ends, and then to delete
-- personal data unless another law requires it to be kept. Until now nothing could be deleted at
-- all. This adds:
--   household_retention  the day a household's relationship ended (set and undone by an
--                        administrator or compliance user) and the day its retention ends; the
--                        change audit records every change to it
--   purge_requests       a request to purge one household whose retention has ended, and its
--                        decision; a request is decided by a different person from the one who
--                        made it; a purged request stays as the purge register (no client data:
--                        ids, dates, who, row counts; the reason and note are sealed with the
--                        firm's key as audit entries are)
--   purge_household()    the only way anything is ever deleted: it removes one household (its
--                        record, every version, its change audit and its retention row) when, and
--                        only when, a pending request exists for it in the firm on the transaction,
--                        the approver is not the requester and the retention period has ended.
--                        It runs as the owner (security definer); the app role may call it and
--                        still has no delete privilege of its own on any table.
-- The access log (0012) is kept: it holds no client data and records who looked at the file.
--
-- refuse_change() is replaced so that the retention triggers allow exactly one more thing: a
-- delete on households, household_versions, audit_log or household_retention, by the owner role,
-- of rows of the one household named in the transaction-local setting app.purge_household, which
-- only purge_household() sets. Every other update, delete and truncate is still refused, as before.

/* ---------- the retention clock ---------- */
create table if not exists household_retention (
  household_id    uuid primary key references households (id),
  firm_id         uuid not null references firms (id),
  ended_on        date,                  -- the day the business relationship ended; null = open (again)
  retention_until date,                  -- ended_on plus the retention period; a purge may be approved from the day after
  changed_by      text not null,
  changed_at      timestamptz not null default now(),
  check ((ended_on is null) = (retention_until is null)),
  check (retention_until is null or retention_until > ended_on)
);
create index if not exists household_retention_firm on household_retention (firm_id, retention_until);

/* ---------- purge requests, and the purge register ---------- */
create table if not exists purge_requests (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null references firms (id),
  household_id    uuid not null,         -- no foreign key: the request outlives the purged household
  retention_until date not null,         -- as it stood when the request was made
  reason          text not null default '',  -- sealed with the firm's key
  requested_by    text not null,
  requested_by_id uuid references users (id),
  requested_at    timestamptz not null default now(),
  status          text not null default 'pending' check (status in ('pending', 'rejected', 'purged')),
  decided_by      text,
  decided_by_id   uuid references users (id),
  decided_at      timestamptz,
  decision_note   text not null default '',  -- sealed with the firm's key
  counts          jsonb                  -- the rows removed, when purged
);
create unique index if not exists purge_requests_open on purge_requests (firm_id, household_id) where status = 'pending';
create index if not exists purge_requests_firm on purge_requests (firm_id, requested_at desc);

-- A request is decided once; only purge_household() (running as the owner) may mark it purged
create or replace function purge_request_guard() returns trigger language plpgsql as $$
begin
  if old.status <> 'pending' then
    raise exception 'purge request % was already decided (%)', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(old) - array['status', 'decided_by', 'decided_by_id', 'decided_at', 'decision_note', 'counts']) <> (to_jsonb(new) - array['status', 'decided_by', 'decided_by_id', 'decided_at', 'decision_note', 'counts']) then
    raise exception 'only the decision of a purge request may change' using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'purged' and not pg_has_role(current_user, 'hwp_owner', 'member') then
    raise exception 'a purge request is marked purged only by purge_household()' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create or replace trigger purge_requests_decided before update on purge_requests for each row execute function purge_request_guard();
create or replace trigger purge_requests_no_delete before delete on purge_requests for each row execute function refuse_change();
create or replace trigger purge_requests_no_truncate before truncate on purge_requests execute function refuse_change();
create or replace trigger household_retention_no_delete before delete on household_retention for each row execute function refuse_change();
create or replace trigger household_retention_no_truncate before truncate on household_retention execute function refuse_change();

/* ---------- the retention triggers: one more exception, for purge_household() alone ---------- */
create or replace function refuse_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (to_jsonb(old) ? 'firm_id') and (to_jsonb(old) ->> 'firm_id') is null and (to_jsonb(new) ->> 'firm_id') is not null
     and (to_jsonb(old) - 'firm_id') = (to_jsonb(new) - 'firm_id') then
    return new;
  end if;
  if tg_op = 'DELETE' and tg_table_name in ('households', 'household_versions', 'audit_log', 'household_retention')
     and pg_has_role(current_user, 'hwp_owner', 'member')
     and coalesce(nullif(current_setting('app.purge_household', true), ''), '-') = coalesce(to_jsonb(old) ->> 'household_id', to_jsonb(old) ->> 'id') then
    return old;
  end if;
  raise exception '% on % is not allowed: records are kept for regulatory retention', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

/* ---------- the purge ---------- */
create or replace function purge_household(p_request uuid, p_by text, p_by_id uuid, p_note text) returns jsonb
language plpgsql security definer as $$
declare
  firm uuid := nullif(current_setting('app.firm_id', true), '')::uuid;
  r purge_requests;
  ret household_retention;
  n_audit int; n_versions int; n_retention int; n_households int;
  removed jsonb;
begin
  if firm is null then raise exception 'no firm set for this transaction' using errcode = 'insufficient_privilege'; end if;
  select * into r from purge_requests where id = p_request and firm_id = firm for update;
  if not found then raise exception 'no purge request % in this firm', p_request using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then raise exception 'purge request % was already decided (%)', p_request, r.status using errcode = 'insufficient_privilege'; end if;
  if coalesce(p_by, '') = '' or p_by = r.requested_by or (p_by_id is not null and p_by_id = r.requested_by_id) then
    raise exception 'a purge is approved by a different person from the one who requested it' using errcode = 'insufficient_privilege';
  end if;
  select * into ret from household_retention where household_id = r.household_id and firm_id = firm for update;
  if not found or ret.ended_on is null or ret.retention_until >= current_date then
    raise exception 'the retention period of household % has not ended', r.household_id using errcode = 'insufficient_privilege';
  end if;

  perform set_config('app.purge_household', r.household_id::text, true);
  -- allow-destructive: approved purge after the retention period (MLR 2017 reg 40); two-person approval; design approved by the user 2026-10-13
  delete from audit_log where household_id = r.household_id and firm_id = firm;
  get diagnostics n_audit = row_count;
  -- allow-destructive: approved purge after the retention period (MLR 2017 reg 40); two-person approval; design approved by the user 2026-10-13
  delete from household_versions where household_id = r.household_id and firm_id = firm;
  get diagnostics n_versions = row_count;
  -- allow-destructive: approved purge after the retention period (MLR 2017 reg 40); two-person approval; design approved by the user 2026-10-13
  delete from household_retention where household_id = r.household_id and firm_id = firm;
  get diagnostics n_retention = row_count;
  -- allow-destructive: approved purge after the retention period (MLR 2017 reg 40); two-person approval; design approved by the user 2026-10-13
  delete from households where id = r.household_id and firm_id = firm;
  get diagnostics n_households = row_count;
  perform set_config('app.purge_household', '', true);
  if n_households <> 1 then raise exception 'household % was not found to purge', r.household_id using errcode = 'no_data_found'; end if;

  removed := jsonb_build_object('households', n_households, 'versions', n_versions, 'auditEntries', n_audit, 'retention', n_retention);
  update purge_requests set status = 'purged', decided_by = p_by, decided_by_id = p_by_id, decided_at = now(), decision_note = coalesce(p_note, ''), counts = removed
    where id = p_request;
  return removed;
end $$;
-- A security definer function searches this schema, then pg_temp last: a temporary table the caller
-- makes can never stand in for one of these tables (PostgreSQL otherwise searches pg_temp first)
do $$ begin
  execute format('alter function purge_household(uuid, text, uuid, text) set search_path = %I, pg_temp', current_schema());
end $$;
revoke all on function purge_household(uuid, text, uuid, text) from public;
grant execute on function purge_household(uuid, text, uuid, text) to hwp_app;

/* ---------- grants: the app role reads and sets the clock, makes and rejects requests; it deletes nothing ---------- */
grant select, insert, update (ended_on, retention_until, changed_by, changed_at) on household_retention to hwp_app;
grant select, insert, update (status, decided_by, decided_by_id, decided_at, decision_note) on purge_requests to hwp_app;

/* ---------- row-level security, forced ---------- */
do $$
declare t text;
begin
  foreach t in array array['household_retention', 'purge_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'firm_rows') then
      execute format('create policy firm_rows on %I to hwp_app using (firm_id = nullif(current_setting(''app.firm_id'', true), '''')::uuid) with check (firm_id = nullif(current_setting(''app.firm_id'', true), '''')::uuid)', t);
    end if;
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'owner_reads') then
      execute format('create policy owner_reads on %I for select to hwp_owner using (true)', t);
    end if;
  end loop;
  -- purge_household() runs as the owner: it marks the request purged ...
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'purge_requests' and policyname = 'owner_purge') then
    create policy owner_purge on purge_requests for update to hwp_owner
      using (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid)
      with check (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
  end if;
  -- ... locks the household's retention row while it checks it (never changes it) ...
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'household_retention' and policyname = 'owner_lock') then
    create policy owner_lock on household_retention for update to hwp_owner
      using (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) with check (false);
  end if;
  -- ... and deletes the rows of the one household it names, in the firm on the transaction
  foreach t in array array['households', 'household_versions', 'audit_log', 'household_retention'] loop
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'owner_purge') then
      execute format('create policy owner_purge on %I for delete to hwp_owner using (firm_id = nullif(current_setting(''app.firm_id'', true), '''')::uuid and %I::text = current_setting(''app.purge_household'', true))',
        t, case when t = 'households' then 'id' else 'household_id' end);
    end if;
  end loop;
end $$;
