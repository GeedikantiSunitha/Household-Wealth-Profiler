/* PostgreSQL connections for the server: a pool, transactions, and applying db/migrations at
   start-up. Loads the "pg" package only when PostgreSQL is used.
   Time limits keep a slow or unreachable database from holding requests for ever: 5 s to get a
   connection, 15 s per statement, and idle connections are dropped after 30 s. TLS comes from the
   URL (sslmode=verify-full&sslrootcert=... when the database is on another machine). */
'use strict';
const { migrate, pgClient } = require('../../../../db/migrate.js');

const POOL_OPTIONS = { connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'household-wealth-profiler' };

function createPool(url, max) {
  let pg;
  try { pg = require('pg'); } catch (e) { throw new Error('DATABASE_URL is set but the "pg" package is missing. Run: npm install'); }
  const pool = new pg.Pool({ connectionString: url, max, ...POOL_OPTIONS });
  pool.on('error', err => console.error(new Date().toISOString(), 'database connection error', err.message));
  return pool;
}

// Runs fn(client) in one transaction: committed when it returns, rolled back when it throws
async function tx(pool, fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}

// Applies any new migration files; several processes starting at once take turns
async function runMigrations(pool, dir) {
  const c = await pool.connect();
  try { await migrate(pgClient(c), { dir, log: m => console.log(new Date().toISOString(), m) }); }
  finally { c.release(); }
}

module.exports = { createPool, tx, runMigrations, POOL_OPTIONS };
