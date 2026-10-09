-- Household Wealth Profiler: multi-firm schema.
-- Every read and write goes through the `api` Edge Function using the service role.
-- Browsers get no direct table access: RLS is on with no policies except "read my own membership".
-- Versions and the audit log can never be changed or deleted, and households cannot be deleted
-- (Money Laundering Regulations: keep records 5 years after the relationship ends).

create table public.firms (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  status     text not null default 'active' check (status in ('active', 'suspended')),
  seats      int  not null default 5 check (seats > 0),
  created_at timestamptz not null default now()
);

create table public.members (
  user_id      uuid primary key references auth.users (id) on delete restrict,
  firm_id      uuid not null references public.firms (id),
  email        text not null,
  display_name text not null,
  role         text not null default 'adviser' check (role in ('admin', 'adviser')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index members_firm on public.members (firm_id);

create table public.households (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null references public.firms (id),
  version     int  not null check (version > 0),
  state       jsonb not null,
  -- Summary columns for the client list, worked out by the API with core.js on every save
  name        text not null default '',
  reference   text not null default '',
  stage       text not null default '',
  rating      text not null default '',
  next_review text not null default '',
  blockers    int  not null default 0,
  created_at  timestamptz not null default now(),
  created_by  text not null,
  updated_at  timestamptz not null default now(),
  updated_by  text not null
);
create index households_firm_updated on public.households (firm_id, updated_at desc);

create table public.household_versions (
  household_id uuid not null references public.households (id),
  version      int  not null,
  state        jsonb not null,
  saved_at     timestamptz not null default now(),
  saved_by     text not null,
  primary key (household_id, version)
);

create table public.audit_log (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.households (id),
  firm_id      uuid not null references public.firms (id),
  ts           timestamptz not null default now(),
  user_id      uuid not null,
  user_name    text not null,
  field        text not null,
  from_value   text not null default '',
  to_value     text not null default '',
  version      int
);
create index audit_household on public.audit_log (household_id, id desc);

/* ---------- retention: nothing is ever deleted or rewritten ---------- */
create function public.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: records are kept for regulatory retention', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
create trigger households_no_delete before delete on public.households for each row execute function public.refuse_change();
create trigger versions_frozen before update or delete on public.household_versions for each row execute function public.refuse_change();
create trigger audit_frozen before update or delete on public.audit_log for each row execute function public.refuse_change();
create trigger households_no_truncate before truncate on public.households execute function public.refuse_change();
create trigger versions_no_truncate before truncate on public.household_versions execute function public.refuse_change();
create trigger audit_no_truncate before truncate on public.audit_log execute function public.refuse_change();

/* ---------- access ---------- */
alter table public.firms enable row level security;
alter table public.members enable row level security;
alter table public.households enable row level security;
alter table public.household_versions enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.firms, public.members, public.households, public.household_versions, public.audit_log from anon, authenticated;
grant select on public.members to authenticated;
create policy "read own membership" on public.members for select to authenticated using (user_id = (select auth.uid()));

/* ---------- writes (service role only) ---------- */
-- Creates a household with version 1 and a "created" audit entry, in one transaction.
create function public.create_household(p_firm uuid, p_state jsonb, p_summary jsonb, p_user_id uuid, p_user text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.households (firm_id, version, state, name, reference, stage, rating, next_review, blockers, created_by, updated_by)
  values (p_firm, 1, p_state, coalesce(p_summary->>'name', ''), coalesce(p_summary->>'reference', ''), coalesce(p_summary->>'stage', ''),
          coalesce(p_summary->>'rating', ''), coalesce(p_summary->>'nextReview', ''), coalesce((p_summary->>'blockers')::int, 0), p_user, p_user)
  returning id into v_id;
  insert into public.household_versions (household_id, version, state, saved_by) values (v_id, 1, p_state, p_user);
  insert into public.audit_log (household_id, firm_id, user_id, user_name, field, to_value, version)
  values (v_id, p_firm, p_user_id, p_user, 'created', coalesce(p_summary->>'name', ''), 1);
  return jsonb_build_object('id', v_id, 'version', 1);
end $$;

-- Saves a new version if nobody else has saved since p_expected. p_changes is the field diff
-- the API worked out against version p_expected. Returns {status, ...} rather than raising, so
-- the API can answer 404 / 409 cleanly.
create function public.save_household(p_id uuid, p_firm uuid, p_expected int, p_state jsonb, p_summary jsonb,
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
    rating = coalesce(p_summary->>'rating', ''), next_review = coalesce(p_summary->>'nextReview', ''), blockers = coalesce((p_summary->>'blockers')::int, 0)
  where id = p_id;
  insert into public.household_versions (household_id, version, state, saved_by) values (p_id, v_next, p_state, p_user);
  insert into public.audit_log (household_id, firm_id, user_id, user_name, field, from_value, to_value, version)
  select p_id, p_firm, p_user_id, p_user, c->>'field', coalesce(c->>'from', ''), coalesce(c->>'to', ''), v_next
  from jsonb_array_elements(p_changes) c;
  return jsonb_build_object('status', 200, 'version', v_next, 'changes', v_n);
end $$;

revoke all on function public.create_household(uuid, jsonb, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.save_household(uuid, uuid, int, jsonb, jsonb, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.refuse_change() from public, anon, authenticated;
grant execute on function public.create_household(uuid, jsonb, jsonb, uuid, text) to service_role;
grant execute on function public.save_household(uuid, uuid, int, jsonb, jsonb, jsonb, uuid, text) to service_role;
grant all on public.firms, public.members, public.households, public.household_versions, public.audit_log to service_role;
