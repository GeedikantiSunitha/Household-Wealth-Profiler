-- Phase 2: the app's own sign-in. Accounts (users, from 0004) get a password hash and an
-- authenticator; sessions, recovery codes, one-time links (password reset, invitation), access
-- requests and an auth event log are added. None of these tables holds client data.
--
-- Row-level security is forced on every table here and on users and memberships. The app role
-- reaches them only inside a transaction that has set app.auth to 'on' (which only the sign-in
-- code does), so a bare query sees nothing, as for client data and firms. The app role may change
-- sign-in columns of an account but never its email, and cannot create accounts: those are made
-- by the owner (operator tooling, and later the operator's approval of an access request).
-- Auth events are kept: no update, delete or truncate, as for the audit log.

alter table users add column if not exists password_hash     text;         -- scrypt string; null = cannot sign in yet
alter table users add column if not exists password_set_at   timestamptz;
alter table users add column if not exists totp_secret       text;         -- sealed with DATA_KEY (rotate-key re-seals it)
alter table users add column if not exists totp_confirmed_at timestamptz;  -- null = authenticator not (or no longer) set up
alter table users add column if not exists totp_last_step    bigint not null default 0;  -- last accepted code's time step: a code is never accepted twice
alter table users add column if not exists failed_attempts   integer not null default 0;
alter table users add column if not exists not_before        timestamptz;  -- progressive delay after failures
alter table users add column if not exists last_sign_in_at   timestamptz;
alter table users add column if not exists reenrol           boolean not null default false; -- true after a recovery-code sign-in: a new authenticator must be set up

create table if not exists sessions (
  id_hash      text primary key,                 -- sha256 of the random id in the cookie
  user_id      uuid not null references users (id),
  firm_id      uuid references firms (id),       -- the firm chosen for this session (null until chosen)
  stage        text not null check (stage in ('password', 'full')),  -- 'password': second step still to do; reaches no data
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,             -- the absolute limit
  user_agent   text not null default '',
  ip           text not null default '',
  revoked_at   timestamptz
);
create index if not exists sessions_user on sessions (user_id);

create table if not exists recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id),
  code_hash  text not null unique,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index if not exists recovery_codes_user on recovery_codes (user_id);

create table if not exists one_time_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id),
  purpose    text not null check (purpose in ('reset', 'invite')),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists one_time_tokens_user on one_time_tokens (user_id, purpose);

create table if not exists access_requests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null,
  firm_name  text not null default '',
  firm_id    uuid references firms (id),          -- set when a firm admin handles requests (Phase 3); null = for the operator
  note       text not null default '',
  status     text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  ip         text not null default '',
  created_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz
);

create table if not exists auth_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid references users (id),
  email      text not null default '',             -- as submitted, for attempts on unknown accounts
  event      text not null,                        -- sign_in, totp, recovery, enrol, sign_out, password_change, ...
  outcome    text not null default '',             -- ok, bad_password, bad_code, replay, slowed, inactive, unknown, ...
  ip         text not null default '',
  user_agent text not null default '',
  detail     text not null default ''
);
create index if not exists auth_events_user on auth_events (user_id, at);
create or replace trigger auth_events_frozen before update or delete on auth_events for each row execute function refuse_change();
create or replace trigger auth_events_no_truncate before truncate on auth_events execute function refuse_change();

/* ---------- grants ---------- */
grant update (password_hash, password_set_at, totp_secret, totp_confirmed_at, totp_last_step, failed_attempts, not_before, last_sign_in_at, reenrol) on users to hwp_app;
grant select, insert, update on sessions, recovery_codes, one_time_tokens to hwp_app;
grant select, insert on access_requests, auth_events to hwp_app;
grant usage, select on sequence auth_events_id_seq to hwp_app;

/* ---------- row-level security, forced; the app role needs app.auth set for the transaction ---------- */
do $$
declare t text;
begin
  foreach t in array array['sessions', 'recovery_codes', 'one_time_tokens', 'access_requests', 'auth_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'auth_rows') then
      execute format('create policy auth_rows on %I to hwp_app using (current_setting(''app.auth'', true) = ''on'') with check (current_setting(''app.auth'', true) = ''on'')', t);
    end if;
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'owner_rows') then
      execute format('create policy owner_rows on %I to hwp_owner using (true) with check (true)', t);
    end if;
  end loop;
  -- accounts and memberships (row security already forced by 0004): readable and, for sign-in columns, changeable by the app role within sign-in
  foreach t in array array['users', 'memberships'] loop
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'auth_rows') then
      execute format('create policy auth_rows on %I to hwp_app using (current_setting(''app.auth'', true) = ''on'') with check (current_setting(''app.auth'', true) = ''on'')', t);
    end if;
  end loop;
  -- firms: their names are shown when a user picks a firm at sign-in (read only; nothing else of a firm)
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'firms' and policyname = 'auth_reads') then
    create policy auth_reads on firms for select to hwp_app using (current_setting('app.auth', true) = 'on');
  end if;
end $$;
