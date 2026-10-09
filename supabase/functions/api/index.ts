// Supabase Edge Function entry point. All logic is in handler.mjs (tested under Node).
// Secrets (set with `supabase secrets set`): APP_ORIGINS, optional REQUIRE_MFA=0.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import '../_shared/core.js'; // copy of public/core.js; sets globalThis.HWP
import { handle } from './handler.mjs';

const HWP = (globalThis as any).HWP;
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const origins = (Deno.env.get('APP_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
const must = <T>({ data, error }: { data: T; error: any }): T => { if (error) throw error; return data; };

const db = {
  async member(userId: string) {
    const m: any = must(await sb.from('members').select('*, firms(name, status, seats)').eq('user_id', userId).maybeSingle());
    return m && { ...m, firm_name: m.firms.name, firm_status: m.firms.status, seats: m.firms.seats };
  },
  listHouseholds: async (firm: string) => must(await sb.from('households')
    .select('id, name, reference, stage, rating, next_review, blockers, review_due, review_overdue, version, updated_at, updated_by')
    .eq('firm_id', firm).order('updated_at', { ascending: false }).limit(10000)),
  getHousehold: async (id: string, firm: string) => must(await sb.from('households').select('*').eq('id', id).eq('firm_id', firm).maybeSingle()),
  audit: async (id: string, firm: string, limit: number) => must(await sb.from('audit_log').select('*')
    .eq('household_id', id).eq('firm_id', firm).order('id', { ascending: false }).limit(limit)),
  createHousehold: async (a: any) => must(await sb.rpc('create_household', { p_firm: a.firm, p_state: a.state, p_summary: a.summary, p_user_id: a.userId, p_user: a.user })),
  saveHousehold: async (a: any) => must(await sb.rpc('save_household', { p_id: a.id, p_firm: a.firm, p_expected: a.expected, p_state: a.state,
    p_summary: a.summary, p_changes: a.changes, p_user_id: a.userId, p_user: a.user })),
  listMembers: async (firm: string) => must(await sb.from('members').select('*').eq('firm_id', firm).order('created_at')),
  async inviteMember(a: any) {
    const { data, error } = await sb.auth.admin.inviteUserByEmail(a.email, { redirectTo: a.redirectTo, data: { name: a.name } });
    if (error) { if ((error as any).code === 'email_exists' || (error as any).status === 422) return { conflict: true }; throw error; }
    const member = must(await sb.from('members').insert({ user_id: data.user.id, firm_id: a.firm, email: a.email, display_name: a.name, role: a.role }).select().single());
    return { member };
  },
  updateMember: async (firm: string, userId: string, patch: any) => must(await sb.from('members').update(patch).eq('firm_id', firm).eq('user_id', userId).select().maybeSingle()),
};

async function verify(token: string) {
  const { data, error } = await sb.auth.getClaims(token);
  const c: any = data?.claims;
  if (error || !c || c.role !== 'authenticated' || !c.sub) return null;
  return { userId: c.sub, email: c.email, aal: c.aal };
}

const deps = { HWP, verify, db, origins, requireMfa: Deno.env.get('REQUIRE_MFA') !== '0', inviteRedirect: (origins[0] || '') + '/?setpw=1' };
Deno.serve(req => handle(req, deps));
