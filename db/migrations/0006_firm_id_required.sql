-- Every firm-owned row must name its firm. 0004 backfilled the default firm and left the column
-- nullable until counts were checked; this makes it required. Refuses to apply, changing nothing,
-- while any row has no firm (the message lists the tables and counts).
do $$
declare t text; n int; problems text := '';
begin
  foreach t in array array['households', 'household_versions', 'audit_log', 'firm_audit', 'idempotency_keys'] loop
    execute format('select count(*) from %I where firm_id is null', t) into n;
    if n > 0 then problems := problems || format('%s: %s row(s) without a firm; ', t, n); end if;
  end loop;
  if problems <> '' then
    raise exception '%nothing was changed. Assign those rows to a firm (0004 assigns pre-tenancy rows to the default firm), then run the migration again', problems;
  end if;
end $$;
alter table households alter column firm_id set not null;
alter table household_versions alter column firm_id set not null;
alter table audit_log alter column firm_id set not null;
alter table firm_audit alter column firm_id set not null;
alter table idempotency_keys alter column firm_id set not null;
