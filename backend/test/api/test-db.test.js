// backend/test/api/test-db.js: the PostgreSQL tests run only against a database named *_test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabaseUrl } = require('./test-db.js');

test('no TEST_DATABASE_URL: the PostgreSQL tests skip', () => {
  assert.equal(testDatabaseUrl({}), '');
  assert.equal(testDatabaseUrl({ TEST_DATABASE_URL: '' }), '');
});

test('a database named *_test is accepted, as given', () => {
  const url = 'postgres://postgres:secret@localhost:5499/hwp_test?options=-c%20search_path%3Dx';
  assert.equal(testDatabaseUrl({ TEST_DATABASE_URL: url }), url);
});

test('any other database is refused before a single test runs', () => {
  for (const name of ['wealth_profiler', 'hwp_test2', 'test_hwp', 'hwp_production']) {
    assert.throws(() => testDatabaseUrl({ TEST_DATABASE_URL: `postgres://postgres@localhost:5432/${name}` }),
      { message: `TEST_DATABASE_URL names the database "${name}". The PostgreSQL tests only run against a database whose name ends in _test, so they can never touch development or production data.` }, name);
  }
  assert.throws(() => testDatabaseUrl({ TEST_DATABASE_URL: 'not a url' }), { message: 'TEST_DATABASE_URL is not a URL' });
});
