-- The owner role may read every firm's rows. Row-level security is forced on every table, so
-- without this the owner (which has no firm) sees nothing at all, and maintenance that must look
-- across firms (rotating DATA_KEY checks that no record is still sealed with it; later, re-sealing
-- and retention) cannot work. Reading means ciphertext only: the owner holds no key. The owner
-- still cannot insert, update or delete through these policies; writes stay with the app role,
-- for one firm at a time.
do $$
declare t text;
begin
  foreach t in array array['households', 'household_versions', 'audit_log', 'firm_records', 'firm_record_versions', 'firm_audit', 'idempotency_keys'] loop
    if not exists (select from pg_policies where schemaname = current_schema() and tablename = t and policyname = 'owner_reads') then
      execute format('create policy owner_reads on %I for select to hwp_owner using (true)', t);
    end if;
  end loop;
end $$;
