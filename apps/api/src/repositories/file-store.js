/* Households as files under one folder (development only: production refuses the file store).
   The default firm keeps the original layout, so data folders from before tenancy still work;
   every other firm has its own folder under firms/<firm id>/ with the same layout:
     households/<id>/current.json        the current record
     households/<id>/versions/NNNNNN.json every saved version
     households/<id>/audit.log           one sealed audit entry per line, oldest first
     households/firm/...                 the firm settings, in the same three forms (the list only
                                         reads folders named by a household id, so it never shows)
     idempotency/<sha256(user:key)>.json the reply to a create, kept a day so a repeat returns it
   Records and audit entries are sealed with the master key before they are written. Writes go
   to a temporary file first and are then renamed, so a crash never leaves half a file. */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { ID_RE, DEFAULT_FIRM_ID } = require('./ids.js');
const { requestHash, replay } = require('./idempotency.js');
const { referenceIndex, indexKeyFor } = require('../crypto/seal.js');

const IDEM_TTL_MS = 24 * 3600e3;
const logUnreadable = (id, e) => console.error(new Date().toISOString(), `unreadable household ${id}:`, e.message);

function createFileStore(root, { seal, open, key }) {
  const indexKey = indexKeyFor(key || Buffer.alloc(32));
  const scopes = new Map();

  function scope(dir) {
    const hhDir = id => path.join(dir, 'households', id);
    const idemDir = path.join(dir, 'idempotency');
    const idemFile = (user, k) => path.join(idemDir, crypto.createHash('sha256').update(`${user}:${k}`).digest('hex') + '.json');
    async function writeAtomic(file, text) {
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      await fsp.writeFile(tmp, text, { mode: 0o600 });
      await fsp.rename(tmp, file);
    }
    async function readRecord(id) {
      try { return JSON.parse(open(await fsp.readFile(path.join(hhDir(id), 'current.json'), 'utf8'))); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }
    async function writeRecord(rec) {
      const text = seal(JSON.stringify(rec));
      await writeAtomic(path.join(hhDir(rec.id), 'versions', `${String(rec.version).padStart(6, '0')}.json`), text);
      await writeAtomic(path.join(hhDir(rec.id), 'current.json'), text);
    }
    async function appendAudit(id, entries) {
      if (!entries.length) return;
      const lines = entries.map(e => seal(JSON.stringify(e)) + '\n').join('');
      await fsp.mkdir(hhDir(id), { recursive: true, mode: 0o700 });
      await fsp.appendFile(path.join(hhDir(id), 'audit.log'), lines, { mode: 0o600 });
    }
    async function readAudit(id) {
      let text = '';
      try { text = await fsp.readFile(path.join(hhDir(id), 'audit.log'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return text.split('\n').filter(Boolean).map(l => JSON.parse(open(l))).reverse();
    }
    async function readVersions(id) {
      let names = [];
      try { names = (await fsp.readdir(path.join(hhDir(id), 'versions'))).filter(f => /^\d+\.json$/.test(f)).sort(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const out = [];
      for (const f of names) out.push(JSON.parse(open(await fsp.readFile(path.join(hhDir(id), 'versions', f), 'utf8'))));
      return out;
    }
    async function ids() {
      try { return (await fsp.readdir(path.join(dir, 'households'))).filter(x => ID_RE.test(x)); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    }
    // The reply stored for this user and key within the last day, else null; a key with a different
    // request is refused. (A file from before request hashes were kept holds the bare reply.)
    async function recallIdem(idem) {
      const f = idemFile(idem.user, idem.key);
      let stored;
      try {
        const st = await fsp.stat(f);
        if (Date.now() - st.mtimeMs > IDEM_TTL_MS) return null;
        stored = JSON.parse(await fsp.readFile(f, 'utf8'));
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      if (!stored.reply) stored = { reply: stored, requestHash: null };
      return replay(stored, requestHash(indexKey, idem.request));
    }
    async function rememberIdem(idem, reply) {
      await writeAtomic(idemFile(idem.user, idem.key), JSON.stringify({ reply, requestHash: requestHash(indexKey, idem.request) }));
      for (const f of await fsp.readdir(idemDir)) { // keys past their day go
        try { const st = await fsp.stat(path.join(idemDir, f)); if (Date.now() - st.mtimeMs > IDEM_TTL_MS) await fsp.unlink(path.join(idemDir, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    // Firm settings: one record beside the households, written the same way
    const FIRM = 'firm';
    async function readFirm() {
      try { return JSON.parse(open(await fsp.readFile(path.join(hhDir(FIRM), 'current.json'), 'utf8'))); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }
    async function writeFirm(rec) {
      const text = seal(JSON.stringify(rec));
      await writeAtomic(path.join(hhDir(FIRM), 'versions', `${String(rec.version).padStart(6, '0')}.json`), text);
      await writeAtomic(path.join(hhDir(FIRM), 'current.json'), text);
    }
    const indexReference = async ref => referenceIndex(indexKey, ref);

    return {
      ids,
      // A record that cannot be read (a wrong key, a damaged file) is left out and reported
      async list({ onUnreadable = logUnreadable } = {}) {
        const out = [];
        for (const id of await ids()) {
          try { const rec = await readRecord(id); if (rec) out.push(rec); } catch (e) { onUnreadable(id, e); }
        }
        return out;
      },
      get: readRecord,
      versions: readVersions,
      indexReference,
      async findByReference(hmac) {
        if (!hmac) return null;
        for (const id of await ids()) {
          try { const rec = await readRecord(id); if (rec && await indexReference(rec.state && rec.state.household && rec.state.household.reference) === hmac) return id; } catch (e) { /* unreadable: not a match */ }
        }
        return null;
      },
      recall: recallIdem,
      async create(rec, audit, idem) {
        if (idem) { const prev = await recallIdem(idem); if (prev) return prev; }
        await writeRecord(rec);
        await appendAudit(rec.id, audit);
        const reply = { id: rec.id, version: rec.version };
        if (idem) await rememberIdem(idem, reply);
        return reply;
      },
      async update(id, decide) {
        const out = await decide(await readRecord(id));
        if (out.next) { await writeRecord(out.next); await appendAudit(id, out.audit || []); }
        return out.result;
      },
      audit: readAudit,
      firm: {
        get: readFirm,
        async update(decide) {
          const out = await decide(await readFirm());
          if (out.next) { await writeFirm(out.next); await appendAudit(FIRM, out.audit || []); }
          return out.result;
        },
        audit: () => readAudit(FIRM),
        versions: () => readVersions(FIRM),
      },
    };
  }

  return {
    describe: 'data in ' + root,
    async init() { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); },
    // For /readyz: the data folder is there and writable
    async ready() { await fsp.access(root, fs.constants.W_OK); },
    forFirm(firmId) {
      if (!ID_RE.test(firmId)) throw new Error('Not a firm id');
      if (!scopes.has(firmId)) scopes.set(firmId, scope(firmId === DEFAULT_FIRM_ID ? root : path.join(root, 'firms', firmId)));
      return scopes.get(firmId);
    },
  };
}

module.exports = { createFileStore };
