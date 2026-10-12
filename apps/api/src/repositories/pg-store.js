/* Households in PostgreSQL (when DATABASE_URL is set). Tables come from db/migrations:
   households (current record), household_versions (every version), audit_log (one row per entry),
   and for the firm settings firm_settings (one row), firm_versions and firm_audit.
   Every doc / entry is sealed text, exactly what the file store writes.
   idempotency_keys keeps each create's reply for a day under a hash of the user and key, written
   in the same transaction as the record, so two servers given the same key cannot both create. */
'use strict';
const crypto = require('crypto');
const { createPool, tx: inTx, runMigrations } = require('../db/pool.js');

const scopeOf = (user, key) => crypto.createHash('sha256').update(`${user}:${key}`).digest('hex');

// Firm saves take this transaction lock first: before the first save there is no row to lock, so
// without it two servers saving at once could both try to create it.
const FIRM_LOCK = '7243100918';

function createPgStore(url, { seal, open, poolMax, migrationsDir }) {
  const pool = createPool(url, poolMax);
  const tx = fn => inTx(pool, fn);
  const sealAll = entries => entries.map(e => seal(JSON.stringify(e)));
  async function insertVersion(c, rec, audit) {
    const doc = seal(JSON.stringify(rec));
    await c.query('insert into household_versions (household_id, version, doc, saved_at) values ($1, $2, $3, $4)', [rec.id, rec.version, doc, rec.updatedAt]);
    if (audit.length) await c.query('insert into audit_log (household_id, entry) select $1, unnest($2::text[])', [rec.id, sealAll(audit)]);
    return doc;
  }
  // A new firm version: the version row, its audit entries, then the current row (created on the first save)
  async function saveFirmVersion(c, rec, audit) {
    const doc = seal(JSON.stringify(rec));
    await c.query('insert into firm_versions (version, doc, saved_at) values ($1, $2, $3)', [rec.version, doc, rec.updatedAt]);
    if (audit.length) await c.query('insert into firm_audit (entry) select unnest($1::text[])', [sealAll(audit)]);
    await c.query(`insert into firm_settings (id, version, doc, updated_at) values (true, $1, $2, $3)
      on conflict (id) do update set version = excluded.version, doc = excluded.doc, updated_at = excluded.updated_at`, [rec.version, doc, rec.updatedAt]);
  }
  let where = 'PostgreSQL';
  try { const u = new URL(url); where = `PostgreSQL ${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch (e) {}
  return {
    describe: 'data in ' + where,
    init: () => runMigrations(pool, migrationsDir),
    // For /readyz: the database answers
    ready: async () => { await pool.query('select 1'); },
    // A row that cannot be read (a wrong key, a damaged row) is left out and reported, so one bad
    // row does not hide every other household
    async list({ onUnreadable = (id, e) => console.error(new Date().toISOString(), `unreadable household ${id}:`, e.message) } = {}) {
      const out = [];
      for (const r of (await pool.query('select id, doc from households')).rows) {
        try { out.push(JSON.parse(open(r.doc))); } catch (e) { onUnreadable(r.id, e); }
      }
      return out;
    },
    async get(id) { const r = (await pool.query('select doc from households where id = $1', [id])).rows[0]; return r ? JSON.parse(open(r.doc)) : null; },
    async create(rec, audit, idem) {
      const scope = idem && scopeOf(idem.user, idem.key);
      try {
        return await tx(async c => {
          if (scope) {
            await c.query(`delete from idempotency_keys where created_at < now() - interval '24 hours'`);
            const prev = (await c.query('select reply from idempotency_keys where scope = $1', [scope])).rows[0];
            if (prev) return JSON.parse(prev.reply);
          }
          const doc = seal(JSON.stringify(rec));
          await c.query('insert into households (id, version, doc, updated_at) values ($1, $2, $3, $4)', [rec.id, rec.version, doc, rec.updatedAt]);
          await insertVersion(c, rec, audit);
          const reply = { id: rec.id, version: rec.version };
          if (scope) await c.query('insert into idempotency_keys (scope, reply) values ($1, $2)', [scope, JSON.stringify(reply)]);
          return reply;
        });
      } catch (e) {
        // The same key at the same moment on another connection: that transaction committed first,
        // this one was rolled back whole (household included); answer with the first reply
        if (scope && e.code === '23505') {
          const prev = (await pool.query('select reply from idempotency_keys where scope = $1', [scope])).rows[0];
          if (prev) return JSON.parse(prev.reply);
        }
        throw e;
      }
    },
    // The row lock (select ... for update) serialises saves across every server process
    async update(id, decide) {
      return tx(async c => {
        const r = (await c.query('select doc from households where id = $1 for update', [id])).rows[0];
        const out = await decide(r ? JSON.parse(open(r.doc)) : null);
        if (out.next) {
          const doc = await insertVersion(c, out.next, out.audit || []);
          await c.query('update households set version = $2, doc = $3, updated_at = $4 where id = $1', [id, out.next.version, doc, out.next.updatedAt]);
        }
        return out.result;
      });
    },
    async audit(id) { return (await pool.query('select entry from audit_log where household_id = $1 order by id desc', [id])).rows.map(r => JSON.parse(open(r.entry))); },
    // import-files: copies one household's whole history; false when it is already there
    async importHousehold(versions, audit) {
      const last = versions[versions.length - 1];
      return tx(async c => {
        if ((await c.query('select 1 from households where id = $1', [last.id])).rows.length) return false;
        await c.query('insert into households (id, version, doc, updated_at) values ($1, $2, $3, $4)', [last.id, last.version, seal(JSON.stringify(last)), last.updatedAt]);
        for (const v of versions) await insertVersion(c, v, []);
        if (audit.length) await c.query('insert into audit_log (household_id, entry) select $1, unnest($2::text[])', [last.id, sealAll(audit)]);
        return true;
      });
    },
    firm: {
      async get() { const r = (await pool.query('select doc from firm_settings')).rows[0]; return r ? JSON.parse(open(r.doc)) : null; },
      async update(decide) {
        return tx(async c => {
          await c.query('select pg_advisory_xact_lock($1::bigint)', [FIRM_LOCK]);
          const r = (await c.query('select doc from firm_settings for update')).rows[0];
          const out = await decide(r ? JSON.parse(open(r.doc)) : null);
          if (out.next) await saveFirmVersion(c, out.next, out.audit || []);
          return out.result;
        });
      },
      async audit() { return (await pool.query('select entry from firm_audit order by id desc')).rows.map(r => JSON.parse(open(r.entry))); },
      // import-files: copies the firm's whole history; false when the database already has firm settings
      async importAll(versions, audit) {
        return tx(async c => {
          await c.query('select pg_advisory_xact_lock($1::bigint)', [FIRM_LOCK]);
          if ((await c.query('select 1 from firm_settings')).rows.length) return false;
          // versions oldest first; the audit trail (oldest first) goes in with the last one
          for (let i = 0; i < versions.length; i++) await saveFirmVersion(c, versions[i], i === versions.length - 1 ? audit : []);
          return true;
        });
      },
    },
    end: () => pool.end(),
  };
}

module.exports = { createPgStore };
