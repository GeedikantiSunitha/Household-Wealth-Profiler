/* Households in PostgreSQL (when DATABASE_URL is set). Tables come from db/migrations:
   households (current record), household_versions (every version), audit_log (one row per entry).
   Every doc / entry is sealed text, exactly what the file store writes. */
'use strict';
const { createPool, tx: inTx, runMigrations } = require('../db/pool.js');

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
  let where = 'PostgreSQL';
  try { const u = new URL(url); where = `PostgreSQL ${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch (e) {}
  return {
    describe: 'data in ' + where,
    init: () => runMigrations(pool, migrationsDir),
    async list() { return (await pool.query('select doc from households')).rows.map(r => JSON.parse(open(r.doc))); },
    async get(id) { const r = (await pool.query('select doc from households where id = $1', [id])).rows[0]; return r ? JSON.parse(open(r.doc)) : null; },
    async create(rec, audit) {
      await tx(async c => {
        const doc = seal(JSON.stringify(rec));
        await c.query('insert into households (id, version, doc, updated_at) values ($1, $2, $3, $4)', [rec.id, rec.version, doc, rec.updatedAt]);
        await insertVersion(c, rec, audit);
      });
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
    end: () => pool.end(),
  };
}

module.exports = { createPgStore };
