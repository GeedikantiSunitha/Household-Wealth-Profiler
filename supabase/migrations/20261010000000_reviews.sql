-- Review diary summary columns for the client list and the firm-wide "Reviews due" page.
alter table public.households
  add column review_due text not null default '',
  add column review_overdue int not null default 0;

create or replace function public.create_household(p_firm uuid, p_state jsonb, p_summary jsonb, p_user_id uuid, p_user text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.households (firm_id, version, state, name, reference, stage, rating, next_review, blockers, review_due, review_overdue, created_by, updated_by)
  values (p_firm, 1, p_state, coalesce(p_summary->>'name', ''), coalesce(p_summary->>'reference', ''), coalesce(p_summary->>'stage', ''),
          coalesce(p_summary->>'rating', ''), coalesce(p_summary->>'nextReview', ''), coalesce((p_summary->>'blockers')::int, 0),
          coalesce(p_summary->>'due', ''), coalesce((p_summary->>'overdue')::int, 0), p_user, p_user)
  returning id into v_id;
  insert into public.household_versions (household_id, version, state, saved_by) values (v_id, 1, p_state, p_user);
  insert into public.audit_log (household_id, firm_id, user_id, user_name, field, to_value, version)
  values (v_id, p_firm, p_user_id, p_user, 'created', coalesce(p_summary->>'name', ''), 1);
  return jsonb_build_object('id', v_id, 'version', 1);
end $$;

create or replace function public.save_household(p_id uuid, p_firm uuid, p_expected int, p_state jsonb, p_summary jsonb,
                                                 p_changes jsonb, p_user_id uuid, p_user text)
returns jsonb language plpgsql set search_path = '' as $$
declare h public.households; v_next int; v_n int := jsonb_array_length(coalesce(p_changes, '[]'::jsonb));
begin
  select * into h from public.households where id = p_id and firm_id = p_firm for update;
  if not found then return jsonb_build_object('status', 404); end if;
  if h.version <> p_expected then
    return jsonb_build_object('status', 409, 'version', h.version, 'updatedBy', h.updated_by, 'updatedAt', h.updated_at);
  end if;
  if v_n = 0 then return jsonb_build_object('status', 200, 'version', h.version, 'changes', 0); end if;
  v_next := h.version + 1;
  update public.households set version = v_next, state = p_state, updated_at = now(), updated_by = p_user,
    name = coalesce(p_summary->>'name', ''), reference = coalesce(p_summary->>'reference', ''), stage = coalesce(p_summary->>'stage', ''),
    rating = coalesce(p_summary->>'rating', ''), next_review = coalesce(p_summary->>'nextReview', ''), blockers = coalesce((p_summary->>'blockers')::int, 0),
    review_due = coalesce(p_summary->>'due', ''), review_overdue = coalesce((p_summary->>'overdue')::int, 0)
  where id = p_id;
  insert into public.household_versions (household_id, version, state, saved_by) values (p_id, v_next, p_state, p_user);
  insert into public.audit_log (household_id, firm_id, user_id, user_name, field, from_value, to_value, version)
  select p_id, p_firm, p_user_id, p_user, c->>'field', coalesce(c->>'from', ''), coalesce(c->>'to', ''), v_next
  from jsonb_array_elements(p_changes) c;
  return jsonb_build_object('status', 200, 'version', v_next, 'changes', v_n);
end $$;
