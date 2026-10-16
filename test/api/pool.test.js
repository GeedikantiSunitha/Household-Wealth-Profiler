// backend/src/db/pool.js: the pool's time limits, and how a transaction behaves when PostgreSQL
// asks for it to be run again or when no connection is free. A fake pool stands in for the
// database, so this runs without one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool, tx, POOL_OPTIONS, RETRIES, runMigrations } = require('../../backend/src/db/pool.js');

test('the pool limits connection waits, statements and idle time, and names itself to the database', async () => {
  assert.deepEqual(POOL_OPTIONS, { connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'household-wealth-profiler' });
  const pool = createPool('postgres://user:secret@localhost:5432/db', 3);
  try {
    assert.equal(pool.options.max, 3);
    for (const [k, v] of Object.entries(POOL_OPTIONS)) assert.equal(pool.options[k], v, k);
  } finally { await pool.end(); }
});

// A fake pool: every connect() hands out a client that records its queries and releases
function fakePool({ connectError } = {}) {
  const log = []; let released = 0;
  const client = { query: async sql => { log.push(sql); }, release: () => { released++; } };
  return { log, released: () => released, connect: async () => { if (connectError) throw connectError; return client; } };
}
const pgError = code => Object.assign(new Error('pg ' + code), { code });
const noSleep = { sleep: async () => {} };

test('a transaction commits on success and rolls back on failure, releasing the connection either way', async () => {
  const pool = fakePool();
  assert.equal(await tx(pool, async c => { await c.query('select 1'); return 'ok'; }, noSleep), 'ok');
  assert.deepEqual(pool.log, ['begin', 'select 1', 'commit']);
  await assert.rejects(tx(pool, async () => { throw new Error('boom'); }, noSleep), { message: 'boom' });
  assert.deepEqual(pool.log.slice(3), ['begin', 'rollback']);
  assert.equal(pool.released(), 2);
});

test('a deadlock or serialization failure is run again, up to 3 attempts, then reported', async () => {
  assert.equal(RETRIES, 3);
  for (const code of ['40P01', '40001']) {
    const pool = fakePool(); let calls = 0;
    const r = await tx(pool, async () => { if (++calls < 3) throw pgError(code); return 'third time'; }, noSleep);
    assert.equal(r, 'third time'); assert.equal(calls, 3, code);
    assert.deepEqual(pool.log, ['begin', 'rollback', 'begin', 'rollback', 'begin', 'commit'], code);
    assert.equal(pool.released(), 3, 'every attempt released its connection');
    const always = fakePool(); let n = 0;
    await assert.rejects(tx(always, async () => { n++; throw pgError(code); }, noSleep), { code });
    assert.equal(n, 3, 'no fourth attempt');
  }
  const pool = fakePool(); let n = 0;
  await assert.rejects(tx(pool, async () => { n++; throw pgError('23505'); }, noSleep), { code: '23505' });
  assert.equal(n, 1, 'any other error is not retried');
});

test('no free connection within the time limit is answered 503 "busy", not a server error', async () => {
  const pool = fakePool({ connectError: new Error('timeout exceeded when trying to connect') });
  await assert.rejects(tx(pool, async () => 'never', noSleep), { status: 503, message: 'The server is busy. Try again in a moment.' });
  const other = fakePool({ connectError: new Error('connection refused') });
  await assert.rejects(tx(other, async () => 'never', noSleep), { message: 'connection refused' });
});

test('a start-up migration runs without the query timeout (the wait for the migration lock may be long) and the pooled connection gets its limit back', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-mig-')); // no migration files: nothing pending
  const queries = [];
  const client = { query: async (sql) => { queries.push(String(sql)); return { rows: /to_regclass/.test(sql) ? [{ exists: false }] : [], rowCount: 0 }; }, release: () => { queries.push('release'); } };
  const pool = { connect: async () => client };
  assert.deepEqual(await runMigrations(pool, dir), []);
  assert.equal(queries[0], 'set statement_timeout = 0');
  assert.deepEqual(queries.slice(-2), [`set statement_timeout = ${POOL_OPTIONS.statement_timeout}`, 'release']);
});
