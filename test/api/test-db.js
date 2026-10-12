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

module.exports = { testDatabaseUrl };
