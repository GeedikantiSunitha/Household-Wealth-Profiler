-- Migration 0004 created its row-level security policies only "if not exists", but looked the
-- policy up by table and name without the schema. In a database that holds several copies of the
-- schema (the test suites run each file in its own), the copy migrated second found the other's
-- policy and was left with row-level security forced and no policy at all. A database with one
-- schema (every real deployment) already has every policy, and this changes nothing there.
-- Creates any policy missing from the current schema, exactly as 0004 defines them.
do $$
declare t text;
begin
  foreach t in array array['households', 'household_versions', 'audit_log', 'firm_records', 'firm_record_versions', 'firm_audit', 'idempotency_keys'] loop
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'firm_rows') then
      execute format('create policy firm_rows on %I to hwp_app using (firm_id = nullif(current_setting(''app.firm_id'', true), '''')::uuid) with check (firm_id = nullif(current_setting(''app.firm_id'', true), '''')::uuid)', t);
    end if;
  end loop;
  foreach t in array array['firms', 'users', 'memberships'] loop
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'owner_rows') then
      execute format('create policy owner_rows on %I to hwp_owner using (true) with check (true)', t);
    end if;
  end loop;
  if not exists (select from pg_policies where schemaname = current_schema() and tablename = 'firms' and policyname = 'own_firm') then
    create policy own_firm on firms to hwp_app using (id = nullif(current_setting('app.firm_id', true), '')::uuid);
  end if;
end $$;
