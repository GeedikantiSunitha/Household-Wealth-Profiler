-- A client reference may exist once per firm (the keyed index of its normalised form). The index
-- is partial: households with no reference are not limited. Refuses to apply, changing nothing,
-- while any duplicate exists: the operator resolves those first (the message says how many).
do $$
declare n int;
begin
  select count(*) into n from (
    select firm_id, reference_hmac from households where reference_hmac is not null group by firm_id, reference_hmac having count(*) > 1
  ) d;
  if n > 0 then
    raise exception '% duplicate client reference(s) exist (groups of households in one firm with the same reference). Resolve them, then run the migration again; nothing was changed', n;
  end if;
end $$;
create unique index if not exists households_reference_unique on households (firm_id, reference_hmac) where reference_hmac is not null;
