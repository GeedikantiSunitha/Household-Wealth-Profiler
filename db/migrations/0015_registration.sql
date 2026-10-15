-- Registration (Phase 5): a person registers, confirms their email address through a link, and
-- signs in; each registration creates a firm with the registrant as its administrator. Replaces
-- Request Access (the access_requests table stays; nothing reads it but the operator's listing
-- and the subject access export).
--
--   users.email_verified_at   when the address was confirmed. New rows default to now(): an
--                             account made by the operator or through an invitation link was
--                             reached at that address already. A registration sets it to null
--                             and the verification link sets it; sign-in is refused until then.
--   one_time_tokens.purpose   gains 'verify' (24 hours, single use, like an invitation)
--   firms                     the app role may insert a firm inside a sign-in transaction (the
--                             registration), and nothing else about firms changes
-- Additive: no column, row or privilege is removed. The check constraint on purpose is replaced
-- by a wider one; no row is touched.

alter table users add column if not exists email_verified_at timestamptz default now();

-- allow-destructive: the purpose check on one_time_tokens is replaced by one that also allows 'verify'; no row is touched (registration design, approved 2026-10-15)
do $$
declare c text;
begin
  select conname into c from pg_constraint
    where conrelid = 'one_time_tokens'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%purpose%';
  if c is not null then execute format('alter table one_time_tokens drop constraint %I', c); end if;
  alter table one_time_tokens add constraint one_time_tokens_purpose_check check (purpose in ('reset', 'invite', 'verify'));
end $$;

grant update (email_verified_at) on users to hwp_app;
grant insert (id, name, status, seats) on firms to hwp_app;

do $$ begin
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'firms' and policyname = 'auth_insert') then
    create policy auth_insert on firms for insert to hwp_app with check (current_setting('app.auth', true) = 'on');
  end if;
end $$;
