/* Households in PostgreSQL (when DATABASE_URL is set). Tables come from db/migrations:
   households (current record), household_versions (every version), audit_log (one row per
   entry), the firm settings in firm_records, firm_record_versions and firm_audit, and
   idempotency_keys (each create's reply, kept a day). Every row carries its firm_id.

   Every call runs in one transaction that first sets app.firm_id for that transaction only
   (set_config(..., true)): the database's row-level security then shows and accepts that firm's
   rows alone, and a pooled connection carries nothing to the next request. The queries also name
   the firm themselves, so isolation does not rest on the policies alone.

   Keys: each firm has its own data key, random, stored wrapped by DATA_KEY in firms.wrapped_key and
   made on the firm's first use. New records are sealed "enc:v2:" with it; records from before
   tenancy ("enc:v1:", master key) still open. The client-reference index uses a key derived from
   the firm's key. Without DATA_KEY (local testing) nothing is encrypted. */
'use strict';
const crypto = require('crypto');
const { createPool, tx: inTx, runMigrations, migrateWith, pendingWith } = require('../db/pool.js');
const { createFirmSealer, newDataKey, wrapKey, unwrapKey, referenceIndex, indexKeyFor } = require('../crypto/seal.js');
const { ID_RE } = require('./ids.js');
const { requestHash, replay } = require('./idempotency.js');

const logUnreadable = (id, e) => console.error(new Date().toISOString(), `unreadable household ${id}:`, e.message);
const refOf = rec => rec && rec.state && rec.state.household ? rec.state.household.reference : undefined;

function createPgStore(url, { key: master, poolMax, migrationsDir, ownerUrl = '', production = false }) {
  const pool = createPool(url, poolMax);
  const tx = fn => inTx(pool, fn);
  const firmKeys = new Map(); // firmId -> { sealer, indexKey }
  const scopes = new Map();

  // The firm's sealer and index key, making the firm's data key on first use (first writer wins)
  async function keysFor(c, firmId) {
    if (firmKeys.has(firmId)) return firmKeys.get(firmId);
    let row = (await c.query('select wrapped_key from firms where id = $1', [firmId])).rows[0];
    if (!row) throw Object.assign(new Error('Unknown firm'), { status: 403 });
    let firmKey = null;
    if (master) {
      if (!row.wrapped_key) {
        await c.query('update firms set wrapped_key = $2 where id = $1 and wrapped_key is null', [firmId, wrapKey(master, newDataKey())]);
        row = (await c.query('select wrapped_key from firms where id = $1', [firmId])).rows[0];
      }
      firmKey = unwrapKey(master, row.wrapped_key);
    }
    const entry = { sealer: createFirmSealer({ master, firmKey }), indexKey: indexKeyFor(firmKey || Buffer.alloc(32)) };
    firmKeys.set(firmId, entry);
    return entry;
  }

  let where = 'PostgreSQL';
  try { const u = new URL(url); where = `PostgreSQL ${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch (e) {}

  function scope(firmId) {
    // One transaction with the firm set; fn gets the client and the firm's seal/open/index
    const inFirm = fn => tx(async c => {
      await c.query("select set_config('app.firm_id', $1, true)", [firmId]);
      const { sealer, indexKey } = await keysFor(c, firmId);
      return fn(c, sealer, indexKey);
    });
    const sealAll = (sealer, entries) => entries.map(e => sealer.seal(JSON.stringify(e)));
    async function insertVersion(c, sealer, rec, audit) {
      const doc = sealer.seal(JSON.stringify(rec));
      await c.query('insert into household_versions (household_id, version, doc, saved_at, firm_id) values ($1, $2, $3, $4, $5)', [rec.id, rec.version, doc, rec.updatedAt, firmId]);
      if (audit.length) await c.query('insert into audit_log (household_id, entry, firm_id) select $1, unnest($2::text[]), $3', [rec.id, sealAll(sealer, audit), firmId]);
      return doc;
    }
    // A new firm-settings version: the version row, its audit entries, then the current row
    async function saveFirmVersion(c, sealer, rec, audit) {
      const doc = sealer.seal(JSON.stringify(rec));
      await c.query('insert into firm_record_versions (firm_id, version, doc, saved_at) values ($1, $2, $3, $4)', [firmId, rec.version, doc, rec.updatedAt]);
      if (audit.length) await c.query('insert into firm_audit (entry, firm_id) select unnest($1::text[]), $2', [sealAll(sealer, audit), firmId]);
      await c.query(`insert into firm_records (firm_id, version, doc, updated_at) values ($1, $2, $3, $4)
        on conflict (firm_id) do update set version = excluded.version, doc = excluded.doc, updated_at = excluded.updated_at`, [firmId, rec.version, doc, rec.updatedAt]);
    }
    const scopeOf = (user, k) => crypto.createHash('sha256').update(`${firmId}:${user}:${k}`).digest('hex');
    async function storedReply(c, indexKey, idem) {
      const r = (await c.query(`select reply, request_hash from idempotency_keys where scope = $1 and firm_id = $2 and created_at >= now() - interval '24 hours'`, [scopeOf(idem.user, idem.key), firmId])).rows[0];
      return r ? replay({ reply: JSON.parse(r.reply), requestHash: r.request_hash }, requestHash(indexKey, idem.request)) : null;
    }

    return {
      async ids() { return inFirm(async c => (await c.query('select id from households where firm_id = $1', [firmId])).rows.map(r => r.id)); },
      // A row that cannot be read (a wrong key, a damaged row) is left out and reported
      list({ onUnreadable = logUnreadable } = {}) {
        return inFirm(async (c, sealer) => {
          const out = [];
          for (const r of (await c.query('select id, doc from households where firm_id = $1', [firmId])).rows) {
            try { out.push(JSON.parse(sealer.open(r.doc))); } catch (e) { onUnreadable(r.id, e); }
          }
          return out;
        });
      },
      get(id) {
        return inFirm(async (c, sealer) => { const r = (await c.query('select doc from households where id = $1 and firm_id = $2', [id, firmId])).rows[0]; return r ? JSON.parse(sealer.open(r.doc)) : null; });
      },
      versions(id) {
        return inFirm(async (c, sealer) => (await c.query('select doc from household_versions where household_id = $1 and firm_id = $2 order by version', [id, firmId])).rows.map(r => JSON.parse(sealer.open(r.doc))));
      },
      indexReference(ref) { return inFirm(async (c, sealer, indexKey) => referenceIndex(indexKey, ref)); },
      findByReference(hmac) {
        if (!hmac) return Promise.resolve(null);
        return inFirm(async c => { const r = (await c.query('select id from households where firm_id = $1 and reference_hmac = $2 limit 1', [firmId, hmac])).rows[0]; return r ? r.id : null; });
      },
      // The reply stored for this user and key within the last day, else null; a key with a different request is refused
      recall(idem) { return inFirm((c, sealer, indexKey) => storedReply(c, indexKey, idem)); },
      async create(rec, audit, idem) {
        const s = idem && scopeOf(idem.user, idem.key);
        try {
          return await inFirm(async (c, sealer, indexKey) => {
            if (s) {
              await c.query(`delete from idempotency_keys where firm_id = $1 and created_at < now() - interval '24 hours'`, [firmId]);
              const prev = await storedReply(c, indexKey, idem);
              if (prev) return prev;
            }
            const doc = sealer.seal(JSON.stringify(rec));
            await c.query('insert into households (id, version, doc, updated_at, firm_id, reference_hmac) values ($1, $2, $3, $4, $5, $6)', [rec.id, rec.version, doc, rec.updatedAt, firmId, referenceIndex(indexKey, refOf(rec))]);
            await insertVersion(c, sealer, rec, audit);
            const reply = { id: rec.id, version: rec.version };
            if (s) await c.query('insert into idempotency_keys (scope, reply, firm_id, request_hash) values ($1, $2, $3, $4)', [s, JSON.stringify(reply), firmId, requestHash(indexKey, idem.request)]);
            return reply;
          });
        } catch (e) {
          // The same key at the same moment on another connection: that transaction committed first,
          // this one was rolled back whole (household included); answer with the first reply
          if (s && e.code === '23505') {
            const prev = await inFirm((c, sealer, indexKey) => storedReply(c, indexKey, idem));
            if (prev) return prev;
          }
          throw e;
        }
      },
      // The row lock (select ... for update) serialises saves across every server process
      update(id, decide) {
        return inFirm(async (c, sealer, indexKey) => {
          const r = (await c.query('select doc from households where id = $1 and firm_id = $2 for update', [id, firmId])).rows[0];
          const out = await decide(r ? JSON.parse(sealer.open(r.doc)) : null);
          if (out.next) {
            const doc = await insertVersion(c, sealer, out.next, out.audit || []);
            await c.query('update households set version = $2, doc = $3, updated_at = $4, reference_hmac = $5 where id = $1 and firm_id = $6', [id, out.next.version, doc, out.next.updatedAt, referenceIndex(indexKey, refOf(out.next)), firmId]);
          }
          return out.result;
        });
      },
      audit(id) {
        return inFirm(async (c, sealer) => (await c.query('select entry from audit_log where household_id = $1 and firm_id = $2 order by id desc', [id, firmId])).rows.map(r => JSON.parse(sealer.open(r.entry))));
      },
      // import-files: copies one household's whole history; false when it is already there
      importHousehold(versions, audit) {
        const last = versions[versions.length - 1];
        return inFirm(async (c, sealer, indexKey) => {
          if ((await c.query('select 1 from households where id = $1 and firm_id = $2', [last.id, firmId])).rows.length) return false;
          await c.query('insert into households (id, version, doc, updated_at, firm_id, reference_hmac) values ($1, $2, $3, $4, $5, $6)', [last.id, last.version, sealer.seal(JSON.stringify(last)), last.updatedAt, firmId, referenceIndex(indexKey, refOf(last))]);
          for (const v of versions) await insertVersion(c, sealer, v, []);
          if (audit.length) await c.query('insert into audit_log (household_id, entry, firm_id) select $1, unnest($2::text[]), $3', [last.id, sealAll(sealer, audit), firmId]);
          return true;
        });
      },
      // Fills the reference index for rows that lack it (node server.js index-references); the count done
      reindexReferences() {
        return inFirm(async (c, sealer, indexKey) => {
          let n = 0;
          for (const r of (await c.query('select id, doc from households where firm_id = $1 and reference_hmac is null', [firmId])).rows) {
            const h = referenceIndex(indexKey, refOf(JSON.parse(sealer.open(r.doc))));
            if (h) { await c.query('update households set reference_hmac = $2 where id = $1 and firm_id = $3', [r.id, h, firmId]); n++; }
          }
          return n;
        });
      },
      firm: {
        get() { return inFirm(async (c, sealer) => { const r = (await c.query('select doc from firm_records where firm_id = $1', [firmId])).rows[0]; return r ? JSON.parse(sealer.open(r.doc)) : null; }); },
        update(decide) {
          return inFirm(async (c, sealer) => {
            await c.query('select pg_advisory_xact_lock(hashtext($1))', [firmId]); // before the first save there is no row to lock
            const r = (await c.query('select doc from firm_records where firm_id = $1 for update', [firmId])).rows[0];
            const out = await decide(r ? JSON.parse(sealer.open(r.doc)) : null);
            if (out.next) await saveFirmVersion(c, sealer, out.next, out.audit || []);
            return out.result;
          });
        },
        audit() { return inFirm(async (c, sealer) => (await c.query('select entry from firm_audit where firm_id = $1 order by id desc', [firmId])).rows.map(r => JSON.parse(sealer.open(r.entry)))); },
        versions() { return inFirm(async (c, sealer) => (await c.query('select doc from firm_record_versions where firm_id = $1 order by version', [firmId])).rows.map(r => JSON.parse(sealer.open(r.doc)))); },
        // import-files: copies the firm's whole history; false when the firm already has settings
        importAll(versions, audit) {
          return inFirm(async (c, sealer) => {
            await c.query('select pg_advisory_xact_lock(hashtext($1))', [firmId]);
            if ((await c.query('select 1 from firm_records where firm_id = $1', [firmId])).rows.length) return false;
            for (let i = 0; i < versions.length; i++) await saveFirmVersion(c, sealer, versions[i], i === versions.length - 1 ? audit : []);
            return true;
          });
        },
      },
    };
  }

  return {
    describe: 'data in ' + where,
    // Development: apply any new migration (as the owner when DATABASE_OWNER_URL is set).
    // Production: never apply; refuse to start while any is pending, so migrations are a
    // deliberate deploy step run as the owner (node server.js migrate).
    async init() {
      if (production) {
        const p = await pendingWith(pool, migrationsDir);
        if (p.length) throw new Error(`Database migrations are pending: ${p.join(', ')}. Run: node server.js migrate (with DATABASE_OWNER_URL).`);
        return;
      }
      if (ownerUrl) await migrateWith(ownerUrl, migrationsDir); else await runMigrations(pool, migrationsDir);
    },
    // For /readyz: the database answers
    ready: async () => { await pool.query('select 1'); },
    forFirm(firmId) {
      if (!ID_RE.test(firmId)) throw new Error('Not a firm id');
      if (!scopes.has(firmId)) scopes.set(firmId, scope(firmId));
      return scopes.get(firmId);
    },
    // A query with no firm set (tests and operator tooling only): shows what the policies allow, which is nothing
    raw: (sql, params) => pool.query(sql, params),
    end: () => pool.end(),
  };
}

module.exports = { createPgStore };
