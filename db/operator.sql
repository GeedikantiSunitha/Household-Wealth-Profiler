-- The platform operator (Phase 3, 3.4): the person who runs the service for several firms. They create
-- firms, set seats, suspend a firm and create or reset accounts, and they can see who has access. They
-- can NOT read or change client records: no household, version, audit trail, firm settings, key or
-- idempotency row, and none of an account's secrets (password hash, authenticator secret, recovery
-- codes, sign-in links, session ids). That is enforced here, by the database, not by the commands.
--
-- Run once as the owner (hwp_owner) after an administrator has created the login role, and again
-- after any migration that adds tables (it is safe to repeat; it first takes everything away and
-- then grants exactly the list below, so it always ends in the same state):
--   create role hwp_operator login password '...' nosuperuser nobypassrls nocreatedb nocreaterole;
--   node server.js grant-operator
-- The operator's connection (DATABASE_OPERATOR_URL) is used by the operator commands only; the server
-- never runs as this role, and the operator's machine does not need DATA_KEY.
do $$
declare t text;
begin
  if not exists (select from pg_roles where rolname = 'hwp_operator') then
    raise exception 'create the hwp_operator role first (see the README, "The platform operator")';
  end if;

  -- start from nothing, so a privilege granted by hand, or by an older version of this script, does not linger
  execute format('revoke all on all tables in schema %I from hwp_operator', current_schema());
  execute format('revoke all on all sequences in schema %I from hwp_operator', current_schema());
  execute format('grant usage on schema %I to hwp_operator', current_schema());

  -- row-level security is forced on these tables, so the operator needs a policy as well as a grant
  foreach t in array array['firms', 'users', 'memberships', 'sessions', 'auth_events'] loop
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'operator_rows') then
      execute format('create policy operator_rows on %I to hwp_operator using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- firms: everything but the wrapped data key
grant select (id, name, status, seats, created_at) on firms to hwp_operator;
grant insert (id, name, status, seats) on firms to hwp_operator;
grant update (name, status, seats) on firms to hwp_operator;

-- accounts: who they are and whether they can sign in; the password can be set, never read
grant select (id, email, name, active, created_at, password_set_at, totp_confirmed_at, failed_attempts, not_before, last_sign_in_at, reenrol) on users to hwp_operator;
grant insert (email, name) on users to hwp_operator;
grant update (name, active, password_hash, password_set_at, failed_attempts, not_before) on users to hwp_operator;

-- who works in which firm, in which role
grant select on memberships to hwp_operator;
grant insert (user_id, firm_id, role, extra_roles) on memberships to hwp_operator;
grant update (role, extra_roles, active, accepted_at, declined_at) on memberships to hwp_operator;

-- sessions: how many are open, and ending them (suspending a firm); never the session ids
grant select (user_id, firm_id, stage, created_at, last_seen_at, expires_at, revoked_at) on sessions to hwp_operator;
grant update (revoked_at) on sessions to hwp_operator;

-- the sign-in and administration event log: read it, add to it, never change it
grant select, insert on auth_events to hwp_operator;
grant usage, select on sequence auth_events_id_seq to hwp_operator;
