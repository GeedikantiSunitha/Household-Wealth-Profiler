-- Phase 3 (3.2): a firm administrator manages the team. The app role may now change a membership's
-- roles, its active flag and the state of an invitation, and nothing else about it: not which
-- account or firm it belongs to, not the account itself (email, name, active), and it still cannot
-- delete a membership.
--
-- Roles. A membership has one primary role (role, as before) and may hold more (extra_roles), for
-- example an administrator who is also a compliance reviewer. A person's roles are the primary role
-- and the extra ones together. Everything that read role keeps working.
--
-- Invitations. An account that already exists is invited to another firm as a pending membership
-- (accepted_at null): it gives no access until the person accepts it at their next sign-in, and
-- declining it (declined_at) closes it. Every membership made before this migration, or by the
-- operator's commands, or for a new account through its own invitation link, is accepted at once.
--
-- The policy that lets sign-in code reach memberships (auth_rows, 0010) matches every row while the
-- transaction says it is a sign-in. That is right for reading someone's firms at sign-in, and too
-- wide for changing them. A RESTRICTIVE policy, which must hold as well as the permissive ones,
-- makes an update reach only a membership of the firm the transaction is working in (app.firm_id,
-- set by the server): a bug that forgot the firm in a query changes nothing instead of changing
-- another firm's team.
alter table memberships add column if not exists extra_roles text[] not null default '{}';
alter table memberships add column if not exists accepted_at timestamptz;
alter table memberships add column if not exists declined_at timestamptz;
update memberships set accepted_at = created_at where accepted_at is null;
alter table memberships alter column accepted_at set default now();

do $$
begin
  if not exists (select from pg_constraint where conname = 'memberships_extra_roles_valid' and conrelid = 'memberships'::regclass) then
    alter table memberships add constraint memberships_extra_roles_valid
      check (extra_roles <@ array['admin', 'adviser', 'compliance']::text[] and not (role = any (extra_roles)));
  end if;
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'memberships' and policyname = 'update_own_firm') then
    create policy update_own_firm on memberships as restrictive for update to hwp_app
      using (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid)
      with check (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
  end if;
end $$;

grant update (role, extra_roles, active, accepted_at, declined_at) on memberships to hwp_app;

-- The team list and the last-administrator check read a firm's memberships
create index if not exists memberships_firm on memberships (firm_id);
