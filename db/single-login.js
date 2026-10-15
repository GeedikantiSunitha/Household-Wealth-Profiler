/* Single-login mode (DB_LOGIN_MODE=single): the database for hosts that give one login and no way
   to create roles (DCDeploy). The model is MMW's: one login owns the tables, runs the migrations and
   is the app's connection; it is not a superuser and cannot bypass row-level security; every table
   forces row-level security, so the policies hold for the owner too; the policies name no role.

   The migration files are not changed (they are applied as they are where roles exist, and an
   applied file must never change). In single-login mode the runner applies them through translate(),
   a fixed set of rules:
     1. role creation (create role hwp_...) is left out
     2. grants to hwp_app, hwp_owner or hwp_operator are left out: the login owns every object
     3. a policy "to hwp_app" applies to every role ("to public"), the one login in practice. The
        restrictive update_own_firm policy (0014) does not bind operator mode, as it never bound
        the owner where roles exist
     4. a policy "to hwp_owner" applies to every role, but only while a command has switched on a
        mode for its transaction or session: operator mode (app.operator = 'on') for the account
        tables (owner_rows: firms, users, memberships, sessions, ...), maintenance mode
        (app.maintenance = 'on') for reading encrypted client rows across firms (owner_reads; the
        purge policies). The server never sets either; operator commands do (config: the owner and
        operator connections are DATABASE_URL with the mode on)
     5. the purge safeguards of 0013 cannot ask "is this hwp_owner?": a delete is allowed for the
        one household that purge_household() names in app.purge_household, and a request is marked
        purged only once its household is gone
   What single-login mode gives up, as MMW does: the login owns the tables, so the protections that
   came from having no ownership (no column-level limits, cannot drop a policy or disable a trigger)
   rest on the application's code (every query parameterised). Firm isolation is unchanged: it is
   row-level security, forced, on a login that cannot bypass it.
   assertTranslated() refuses a file in which a role reference is left: a new migration with a role
   in it needs a rule here first (new migrations should name no role at all). */
'use strict';

// Created (or replaced) before each migration in single-login mode: the two modes a command can switch on
const PRELUDE = `
create or replace function hwp_operator_mode() returns boolean language sql stable as $f$ select coalesce(current_setting('app.operator', true), '') = 'on' $f$;
create or replace function hwp_maintenance_mode() returns boolean language sql stable as $f$ select coalesce(current_setting('app.maintenance', true), '') = 'on' $f$;
`;

const ROLE = /\bhwp_(?:app|owner|operator)\b/;

// The index just after the parenthesis that closes the one at `open`
function closeOf(sql, open) {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return i;
  }
  throw new Error('unbalanced parentheses in a policy expression');
}

// After `from`: wrap the USING (...) and an immediately following WITH CHECK (...) expression
function wrapExpressions(sql, from, wrap) {
  const stop = sql.slice(from).search(/;|create policy|',\s*t\)/i);
  const end = stop < 0 ? sql.length : from + stop;
  let out = sql.slice(0, from), i = from;
  for (const word of [/using\s*\(/i, /with check\s*\(/i]) {
    const m = word.exec(sql.slice(i, end));
    if (!m) continue;
    const open = i + m.index + m[0].length - 1, close = closeOf(sql, open);
    out += sql.slice(i, open + 1) + wrap(sql.slice(open + 1, close)) + ')';
    i = close + 1;
  }
  return out + sql.slice(i);
}

function translate(sql) {
  let s = sql;
  // 1. role creation
  s = s.replace(/^[ \t]*if not exists \(select from pg_roles where rolname = 'hwp_\w+'\) then create role [^;]*; end if;[ \t]*\n/gim, '');
  // 2. grants (a statement of its own, or one run by execute format inside a do block)
  s = s.replace(/^[ \t]*grant\b[^;]*\bto\s+hwp_(?:app|owner|operator)\s*;[ \t]*\n/gim, '');
  s = s.replace(/^[ \t]*execute format\('grant [^']*\bto hwp_(?:app|owner|operator)'[^;]*\);[ \t]*\n/gim, '');
  // 5. the purge safeguards
  s = s.replace(/not pg_has_role\(current_user, 'hwp_owner', 'member'\)/g, 'exists (select 1 from households h where h.id = new.household_id)');
  s = s.replace(/pg_has_role\(current_user, 'hwp_owner', 'member'\)/g, 'true');
  // 3 and 4. policies, one at a time, so each can be wrapped in place
  for (;;) {
    const m = /create policy (\w+) on (?:%I|\w+)[^;]*?\bas restrictive\b[^;]*?\bto hwp_app\b|create policy (\w+) on (?:%I|\w+)[^;]*?\bto (hwp_app|hwp_owner)\b/i.exec(s);
    if (!m) break;
    const at = m.index + m[0].lastIndexOf('to hwp_');
    const role = m[3] || 'hwp_app', name = m[1] || m[2];
    s = s.slice(0, at) + 'to public' + s.slice(at + ('to ' + role).length);
    if (m[1]) s = wrapExpressions(s, at, e => `hwp_operator_mode() or (${e})`);                 // restrictive: operator mode is not bound by it
    else if (role === 'hwp_owner') s = wrapExpressions(s, at, e => `${name === 'owner_rows' ? 'hwp_operator_mode()' : 'hwp_maintenance_mode()'} and (${e})`);
  }
  return s;
}

// Code without comments, to look for a role reference left behind (comments may mention roles)
const code = sql => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

function assertTranslated(file, sql) {
  const c = code(sql);
  if (ROLE.test(c) || /create role|pg_has_role/i.test(c)) {
    const line = c.split('\n').find(l => ROLE.test(l) || /create role|pg_has_role/i.test(l));
    throw new Error(`${file}: single-login mode has no rule for this role reference, nothing was applied: ${line.trim().slice(0, 120)}`);
  }
}

module.exports = { translate, assertTranslated, PRELUDE };
