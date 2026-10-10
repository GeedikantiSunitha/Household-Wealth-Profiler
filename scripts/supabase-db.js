#!/usr/bin/env node
// Supabase edition database on any PostgreSQL 14+: a Supabase project, self-hosted Supabase, or
// plain PostgreSQL. Needs the "pg" package and a direct connection string in DATABASE_URL.
//   node scripts/supabase-db.js migrate    apply new supabase/migrations files
//   node scripts/supabase-db.js backfill   recompute the client-list columns from each saved household
//
// migrate records what it applies in Supabase CLI's own table, so it and `supabase db push` can be
// mixed. On plain PostgreSQL it first creates stand-ins for Supabase's auth schema and roles
// (supabase/plain-postgres.sql). backfill rewrites only the derived list columns (stage, rating,
// review due, ...): saved state, versions and the audit trail are never touched.
'use strict';
const fs = require('fs');
const path = require('path');
const { migrate, pgClient } = require('../db/migrate.js');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const BOOTSTRAP = path.join(ROOT, 'supabase', 'plain-postgres.sql');

// Real Supabase always has auth.users; anywhere else gets the stand-ins (in one transaction)
async function bootstrap(db) {
  const [{ supabase }] = await db.query(`select to_regclass('auth.users') is not null as supabase`);
  if (supabase) return false;
  await db.exec('begin');
  try { await db.exec(fs.readFileSync(BOOTSTRAP, 'utf8')); await db.exec('commit'); }
  catch (e) { await db.exec('rollback').catch(() => {}); throw e; }
  return true;
}

const migrateSupabase = (db, log) => migrate(db, { dir: MIGRATIONS, tracking: 'supabase', log,
  before: async d => { if (await bootstrap(d)) log && log('created Supabase stand-ins (auth schema and roles)'); } });

const COLS = { name: 'name', reference: 'reference', stage: 'stage', rating: 'rating', nextReview: 'next_review',
  blockers: 'blockers', due: 'review_due', overdue: 'review_overdue' };

// Returns { checked, updated }. Rows already correct are left alone.
async function backfill(db) {
  const HWP = require('../packages/core/core.js');
  const { summarise } = await import('../supabase/functions/api/handler.mjs');
  const rows = await db.query(`select id, state, ${Object.values(COLS).join(', ')} from public.households`);
  let updated = 0;
  await db.exec('begin');
  try {
    for (const r of rows) {
      const s = summarise(HWP, typeof r.state === 'string' ? JSON.parse(r.state) : r.state);
      if (Object.entries(COLS).every(([k, c]) => String(r[c]) === String(s[k]))) continue;
      await db.query(`update public.households set ${Object.values(COLS).map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
        [r.id, ...Object.keys(COLS).map(k => s[k])]);
      updated++;
    }
    await db.exec('commit');
  } catch (e) { await db.exec('rollback').catch(() => {}); throw e; }
  return { checked: rows.length, updated };
}

module.exports = { migrateSupabase, backfill };

if (require.main === module) {
  const what = process.argv[2];
  if (!['migrate', 'backfill'].includes(what) || !process.env.DATABASE_URL) {
    console.error('Usage: DATABASE_URL=postgres://... node scripts/supabase-db.js migrate|backfill');
    process.exit(1);
  }
  (async () => {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      if (what === 'migrate') {
        const done = await migrateSupabase(pgClient(c), console.log);
        console.log(done.length ? `Applied ${done.length} migration(s).` : 'Already up to date.');
      } else {
        const { checked, updated } = await backfill(pgClient(c));
        console.log(`Checked ${checked} household(s), updated the list columns of ${updated}.`);
      }
    } finally { await c.end(); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
