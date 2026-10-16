/* Ordered SQL migrations with a record of what has been applied. No dependencies.
   Used by server.js (db/migrations).

   - Files run in name order, each in its own transaction with its tracking row, so a failed
     migration leaves nothing half-applied and is retried on the next run
   - An advisory lock makes several processes starting at once take turns
   - Migrations only ever add: none of them drops or rewrites client data, and the retention
     triggers refuse deletes anyway

   `db` is a single connection: { query(sql, params) -> rows, exec(sql) } (exec may hold several statements). */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { translate, assertTranslated, PRELUDE } = require('./single-login.js');

const MIN_VERSION = 140000; // PostgreSQL 14: create or replace trigger
const LOCK_KEY = '7243100917'; // any constant; shared by everyone migrating this database

const TRACKING = {
  // server.js: its own table, with a checksum so an edited migration is caught
  app: {
    create: `create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`,
    applied: `select name as key, checksum from schema_migrations`,
    key: file => file,
    record: `insert into schema_migrations (name, checksum) values ($1, $2)`,
    params: (file, sum) => [file, sum],
  },
};

const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); // same checksum on every checkout
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// singleLogin: apply each file through db/single-login.js (one login, no roles; DCDeploy). The checksum
// is always the file's own, so schema_migrations reads the same in both modes.
async function migrate(db, { dir, tracking = 'app', before, log = () => {}, singleLogin = false }) {
  const t = TRACKING[tracking];
  const [{ n }] = await db.query(`select current_setting('server_version_num')::int as n`);
  if (n < MIN_VERSION) throw new Error(`PostgreSQL 14 or later is needed (this server is ${Math.floor(n / 10000)})`);

  await db.query('select pg_advisory_lock($1::bigint)', [LOCK_KEY]);
  try {
    if (before) await before(db);
    await db.exec(t.create);
    const applied = new Map((await db.query(t.applied)).map(r => [r.key, r.checksum]));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const done = [];
    // Single-login mode: every pending file must translate cleanly before the first one is applied
    const plan = new Map();
    if (singleLogin) for (const file of files) if (!applied.has(t.key(file))) { const sql = translate(read(path.join(dir, file))); assertTranslated(file, sql); plan.set(file, PRELUDE + sql); }
    for (const file of files) {
      const sql = read(path.join(dir, file)), sum = sha256(sql), key = t.key(file);
      if (applied.has(key)) {
        const was = applied.get(key);
        if (was && was !== sum) throw new Error(`${file} was changed after it was applied. Put the change in a new migration file instead.`);
        continue;
      }
      await db.exec('begin');
      try {
        await db.exec(singleLogin ? plan.get(file) : sql);
        await db.query(t.record, t.params(file, sum));
        await db.exec('commit');
      } catch (e) {
        await db.exec('rollback').catch(() => {});
        e.message = `migration ${file} failed, nothing from it was applied: ${e.message}`;
        throw e;
      }
      log(`applied migration ${file}`);
      done.push(file);
    }
    return done;
  } finally {
    await db.query('select pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {});
  }
}

// The migration files not yet applied, without changing anything (a production server checks
// this at start-up and refuses to run until `node server.js migrate` has been run as the owner)
async function pending(db, { dir, tracking = 'app' }) {
  const t = TRACKING[tracking];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const table = 'schema_migrations';
  const [{ exists }] = await db.query(`select to_regclass($1) is not null as exists`, [table]);
  if (!exists) return files;
  const applied = new Set((await db.query(t.applied)).map(r => r.key));
  return files.filter(f => !applied.has(t.key(f)));
}

// Adapter for a node-postgres client (not a pool: the advisory lock belongs to one connection)
const pgClient = c => ({ query: async (sql, params) => (await c.query(sql, params)).rows, exec: sql => c.query(sql) });

module.exports = { migrate, pending, pgClient, MIN_VERSION };
