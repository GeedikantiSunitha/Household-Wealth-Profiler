// apps/api/src/db/pool.js: the pool's time limits. Making a pool opens no connection, so this
// runs without a database.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool, POOL_OPTIONS } = require('../../apps/api/src/db/pool.js');

test('the pool limits connection waits, statements and idle time, and names itself to the database', async () => {
  assert.deepEqual(POOL_OPTIONS, { connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'household-wealth-profiler' });
  const pool = createPool('postgres://user:secret@localhost:5432/db', 3);
  try {
    assert.equal(pool.options.max, 3);
    for (const [k, v] of Object.entries(POOL_OPTIONS)) assert.equal(pool.options[k], v, k);
  } finally { await pool.end(); }
});
