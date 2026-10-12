/* PostgreSQL connections for the server: a pool, transactions, and applying db/migrations at
   start-up. Loads the "pg" package only when PostgreSQL is used.
   Time limits keep a slow or unreachable database from holding requests for ever: 5 s to get a
   connection, 15 s per statement, and idle connections are dropped after 30 s. TLS comes from the
   URL (sslmode=verify-full&sslrootcert=... when the database is on another machine). */
'use strict';
const { migrate, pending, pgClient } = require('../../../../db/migrate.js');

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

const logLine = m => console.log(new Date().toISOString(), m);

// Applies any new migration files; several processes starting at once take turns. Nothing is
// touched when none is pending, so the app role (which may not create tables) starts fine.
async function runMigrations(pool, dir) {
  const c = await pool.connect();
  try {
    const db = pgClient(c);
    if (!(await pending(db, { dir })).length) return [];
    return await migrate(db, { dir, log: logLine });
  } catch (e) {
    if (e.code === '42501') e.message = `${e.message}. Migrations are pending and DATABASE_URL cannot apply them: set DATABASE_OWNER_URL, or run node server.js migrate as the owner.`;
    throw e;
  } finally { c.release(); }
}

// The same, on a separate connection as the owner (DATABASE_OWNER_URL)
async function migrateWith(url, dir) {
  const pg = require('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await migrate(pgClient(c), { dir, log: logLine }); }
  finally { await c.end(); }
}

// The migration files not yet applied, changing nothing
async function pendingWith(pool, dir) {
  const c = await pool.connect();
  try { return await pending(pgClient(c), { dir }); }
  finally { c.release(); }
}

module.exports = { createPool, tx, runMigrations, migrateWith, pendingWith, POOL_OPTIONS };
