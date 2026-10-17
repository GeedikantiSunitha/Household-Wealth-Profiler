// The scratch database for the PostgreSQL tests. Its name must end in _test: the tests create
// tables and roles and leave rows behind, so they must never be pointed at a development or
// production database by mistake. Returns TEST_DATABASE_URL, or '' when it is not set (the
// PostgreSQL tests then skip); throws when it names any other database.
'use strict';

function testDatabaseUrl(env = process.env) {
  const url = env.TEST_DATABASE_URL;
  if (!url) return '';
  let name;
  try { name = new URL(url).pathname.slice(1); } catch (e) { throw new Error('TEST_DATABASE_URL is not a URL'); }
  if (!/_test$/.test(name)) throw new Error(`TEST_DATABASE_URL names the database "${name}". The PostgreSQL tests only run against a database whose name ends in _test, so they can never touch development or production data.`);
  return url;
}

// The password the test roles get: one for every test file of a run. Test files run at the same time
// in separate processes and each sets the roles' password; with a password of its own, one file's
// "alter role" locked the others out mid-run ("password authentication failed", seen on CI, whose
// PostgreSQL checks passwords; a local cluster with trust authentication never shows it). Derived from
// TEST_DATABASE_URL, so every process of a run agrees without sharing anything. Scratch clusters only.
const TEST_ROLE_PASSWORD = require('crypto').createHash('sha256').update('hwp test roles:' + (process.env.TEST_DATABASE_URL || '')).digest('hex').slice(0, 24);

// The database roles the migrations (hwp_owner, hwp_app) and db/operator.sql (hwp_operator) expect, with
// TEST_ROLE_PASSWORD. PostgreSQL refuses two "alter role" statements on one role at once ("tuple
// concurrently updated"), so the work is done under an advisory lock. Any other password is refused:
// it would lock out the test files running beside this one.
async function ensureRoles(admin, password = TEST_ROLE_PASSWORD) {
  if (password !== TEST_ROLE_PASSWORD) throw new Error('ensureRoles: use TEST_ROLE_PASSWORD; a password of one test file\'s own locks the other files out');
  await admin.query('select pg_advisory_lock(7206101)');
  try {
    for (const r of ['hwp_owner', 'hwp_app', 'hwp_operator']) {
      await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = '${r}') then create role ${r} nosuperuser nobypassrls; end if; end $$`);
      await admin.query(`alter role ${r} login password '${password}'`);
    }
  } finally { await admin.query('select pg_advisory_unlock(7206101)'); }
}

module.exports = { testDatabaseUrl, ensureRoles, TEST_ROLE_PASSWORD };
