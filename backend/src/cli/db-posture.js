/* node server.js check-db-posture: is the database still safe for client data? Read-only: it changes
   nothing, connects as the app's own login (DATABASE_URL) and prints PASS or FAIL for each check.
   Run it before every deploy; exit 0 all passed, 2 a check failed, 1 it could not run.
     login       not a superuser and cannot bypass row-level security (otherwise no policy holds);
                 with separate roles, the app login also owns no table (so it cannot switch RLS off)
     sessions    this connection has neither operator nor maintenance mode on
     rls         every table forces row-level security and has at least one policy, except the named
                 tables that hold no client or account data (NO_RLS)
     isolation   with no firm set, no household is visible
     retention   every table whose rows are kept has its retention triggers (no delete, no truncate)
     purge       purge_household() exists, runs as its owner, and searches pg_temp last
     single      (single-login mode) the operator and maintenance mode functions exist and every
                 policy applies to every role (none names a role that a host may not have)
     migrations  none is pending */
'use strict';
const fs = require('fs');
const path = require('path');

// Tables without row-level security, on purpose: none holds client or account data
const NO_RLS = ['schema_migrations', 'firm_settings', 'firm_versions'];
// Tables whose rows are kept: no delete and no truncate except through purge_household()
const KEPT = ['households', 'household_versions', 'audit_log', 'firm_records', 'firm_record_versions', 'firm_audit', 'auth_events', 'access_log', 'purge_requests', 'household_retention'];

async function checkDbPosture({ url, singleLogin = false, migrationsDir, log = console.log }) {
  if (!url) { console.error('Set DATABASE_URL: the posture is checked as the app\'s own login.'); return 1; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  try {
    const one = async (sql, p) => (await c.query(sql, p)).rows[0];
    const all = async (sql, p) => (await c.query(sql, p)).rows;
    const who = await one("select current_user as login, rolsuper, rolbypassrls, current_schema() as schema, current_setting('server_version') as version from pg_roles where rolname = current_user");
    const owned = (await one("select count(*)::int n from pg_class where relnamespace = current_schema()::regnamespace and relkind = 'r' and relowner = (select oid from pg_roles where rolname = current_user)")).n;
    check('login', !who.rolsuper && !who.rolbypassrls && (singleLogin || owned === 0),
      `superuser ${who.rolsuper ? 'YES' : 'no'}, bypasses RLS ${who.rolbypassrls ? 'YES' : 'no'}, owns ${owned} table(s)${singleLogin ? ' (single login: it owns them, as expected)' : ''}; PostgreSQL ${who.version}`);

    const modes = await one("select coalesce(current_setting('app.operator', true), '') op, coalesce(current_setting('app.maintenance', true), '') mt");
    check('sessions', modes.op !== 'on' && modes.mt !== 'on', modes.op === 'on' || modes.mt === 'on' ? 'DATABASE_URL switches on operator or maintenance mode' : 'neither operator nor maintenance mode is on');

    const tables = await all(`select c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced, (select count(*)::int from pg_policies p where p.schemaname = current_schema() and p.tablename = c.relname) policies
      from pg_class c where c.relnamespace = current_schema()::regnamespace and c.relkind = 'r' order by 1`);
    const weak = tables.filter(t => !NO_RLS.includes(t.relname) && !(t.rls && t.forced && t.policies > 0));
    check('rls', weak.length === 0, weak.length ? 'not forced or without a policy: ' + weak.map(t => t.relname).join(', ') : `${tables.length - tables.filter(t => NO_RLS.includes(t.relname)).length} table(s) force RLS with policies; ${NO_RLS.filter(n => tables.some(t => t.relname === n)).length} named table(s) hold no client data`);

    const hh = tables.some(t => t.relname === 'households') ? (await one('select count(*)::int n from households')).n : 0;
    check('isolation', hh === 0, `${hh} household(s) visible with no firm set`);

    const trig = await all(`select c.relname, count(*) filter (where t.tgtype & 8 = 8)::int deletes, count(*) filter (where t.tgtype & 32 = 32)::int truncates
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where c.relnamespace = current_schema()::regnamespace and not t.tgisinternal and p.proname = 'refuse_change' group by 1`);
    const missing = KEPT.filter(n => tables.some(t => t.relname === n)).filter(n => { const r = trig.find(x => x.relname === n); return !r || !r.deletes || !r.truncates; });
    check('retention', missing.length === 0, missing.length ? 'without a no-delete and no-truncate trigger: ' + missing.join(', ') : `${KEPT.length} kept table(s) refuse delete and truncate`);

    const purge = await one(`select p.prosecdef, array_to_string(p.proconfig, ',') cfg from pg_proc p where p.proname = 'purge_household' and p.pronamespace = current_schema()::regnamespace`);
    check('purge', !!purge && purge.prosecdef && /search_path=.*pg_temp$/.test(purge.cfg || ''), purge ? `security definer ${purge.prosecdef ? 'yes' : 'NO'}, ${purge.cfg || 'no search_path set'}` : 'purge_household() not found');

    if (singleLogin) {
      const fns = (await all("select proname from pg_proc where pronamespace = current_schema()::regnamespace and proname in ('hwp_operator_mode', 'hwp_maintenance_mode')")).length;
      const named = await all("select tablename, policyname, roles::text from pg_policies where schemaname = current_schema() and not ('public' = any(roles))");
      check('single', fns === 2 && named.length === 0, `${fns}/2 mode function(s); ${named.length ? 'policies naming a role: ' + named.map(p => `${p.tablename}.${p.policyname}`).join(', ') : 'every policy applies to every role'}`);
    }

    const files = migrationsDir ? fs.readdirSync(migrationsDir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort() : [];
    const done = new Set(tables.some(t => t.relname === 'schema_migrations') ? (await all('select name from schema_migrations')).map(r => r.name) : []);
    const pending = files.filter(f => !done.has(f));
    check('migrations', pending.length === 0, pending.length ? 'pending: ' + pending.join(', ') : `${done.size} applied, none pending`);
  } finally { await c.end(); }
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(10)} ${r.detail}`);
  const ok = results.every(r => r.ok);
  log(ok ? 'The database posture is safe for client data.' : 'The database posture is NOT safe: fix every FAIL before deploying.');
  return ok ? 0 : 2;
}

module.exports = { checkDbPosture, NO_RLS, KEPT };
