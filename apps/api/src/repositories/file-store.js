/* Households as files under one folder (development only: production refuses the file store).
   The default firm keeps the original layout, so data folders from before tenancy still work;
   every other firm has its own folder under firms/<firm id>/ with the same layout:
     households/<id>/current.json        the current record
     households/<id>/versions/NNNNNN.json every saved version
     households/<id>/audit.log           one sealed audit entry per line, oldest first
     households/firm/...                 the firm settings, in the same three forms (the list only
                                         reads folders named by a household id, so it never shows)
     idempotency/<sha256(user:key)>.json the reply to a create, kept a day so a repeat returns it
     access.log                          who read what: one JSON line per entry (no client data)
     retention/<id>.json                 the day a household's relationship ended and its retention ends
     purge-requests/<id>.json            purge requests and the purge register (reason and note sealed)
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
const ACCESS_LIMIT = 5000;
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
    // Phase 4: the access log, the retention clock and purge requests (reason and note sealed)
    const accessFile = path.join(dir, 'access.log');
    const retentionDir = path.join(dir, 'retention');
    const requestsDir = path.join(dir, 'purge-requests');
    async function readRetention(id) {
      try { return JSON.parse(await fsp.readFile(path.join(retentionDir, id + '.json'), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }
    async function readRequests() {
      let names = [];
      try { names = (await fsp.readdir(requestsDir)).filter(f => f.endsWith('.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const out = [];
      for (const f of names) { const r = JSON.parse(await fsp.readFile(path.join(requestsDir, f), 'utf8')); out.push({ ...r, reason: open(r.reason), note: open(r.note) }); }
      return out;
    }
    const writeRequest = r => writeAtomic(path.join(requestsDir, r.id + '.json'), JSON.stringify({ ...r, reason: seal(r.reason), note: seal(r.note) }));

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
      // The access log: one JSON line per entry, oldest first (no client data, as in PostgreSQL)
      async logAccess(e) {
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        const entry = { at: new Date().toISOString(), actor: e.actor, userId: e.userId || null, action: e.action, householdId: e.householdId || null, outcome: e.outcome || 'ok', detail: String(e.detail || '').slice(0, 200) };
        await fsp.appendFile(accessFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
      },
      async accessLog(householdId, { limit = ACCESS_LIMIT } = {}) {
        let text = '';
        try { text = await fsp.readFile(accessFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        return text.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.householdId === householdId).reverse().slice(0, limit)
          .map(e => ({ at: e.at, actor: e.actor, action: e.action, outcome: e.outcome, detail: e.detail }));
      },
      retention: {
        async all() {
          let names = [];
          try { names = (await fsp.readdir(retentionDir)).filter(f => ID_RE.test(f.replace(/\.json$/, ''))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          const out = [];
          for (const f of names) out.push(JSON.parse(await fsp.readFile(path.join(retentionDir, f), 'utf8')));
          return out;
        },
        get: readRetention,
        // As in PostgreSQL: decide({ current, pending }) or decide(null) for no such household
        async update(id, decide) {
          if (!(await readRecord(id))) return (await decide(null)).result;
          const pending = (await readRequests()).some(r => r.householdId === id && r.status === 'pending');
          const out = await decide({ current: await readRetention(id), pending });
          if (out.next) {
            await writeAtomic(path.join(retentionDir, id + '.json'), JSON.stringify({ householdId: id, endedOn: out.next.endedOn, retentionUntil: out.next.retentionUntil, changedBy: out.next.by, changedAt: new Date().toISOString() }));
            await appendAudit(id, out.audit || []);
          }
          return out.result;
        },
      },
      purge: {
        async list() { return (await readRequests()).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)); },
        async get(reqId) { return ID_RE.test(reqId) ? (await readRequests()).find(r => r.id === reqId) || null : null; },
        async request({ householdId, reason, by, byId }) {
          const ret = await readRetention(householdId);
          if (!ret || !ret.endedOn) throw Object.assign(new Error("This household's relationship has not ended"), { status: 409, code: 'relationship_open' });
          if ((await readRequests()).some(r => r.householdId === householdId && r.status === 'pending')) throw Object.assign(new Error('A purge request for this household is already waiting for a decision'), { status: 409, code: 'purge_pending' });
          const r = { id: crypto.randomUUID(), householdId, retentionUntil: ret.retentionUntil, reason: reason || '', requestedBy: by, requestedById: byId || null, requestedAt: new Date().toISOString(), status: 'pending', decidedBy: null, decidedById: null, decidedAt: null, note: '', counts: null };
          await writeRequest(r);
          return r;
        },
        async reject(reqId, { by, byId, note }) {
          const r = await this.get(reqId);
          if (!r || r.status !== 'pending') return null;
          Object.assign(r, { status: 'rejected', decidedBy: by, decidedById: byId || null, decidedAt: new Date().toISOString(), note: note || '' });
          await writeRequest(r);
          return r;
        },
        // The same checks as purge_household() in PostgreSQL, then the household's folder and retention file go
        async execute(reqId, { by, byId, note }) {
          const refuse = m => Object.assign(new Error(m), { status: 409, code: 'purge_refused' });
          const r = await this.get(reqId);
          if (!r) throw refuse(`no purge request ${reqId} in this firm`);
          if (r.status !== 'pending') throw refuse(`purge request ${reqId} was already decided (${r.status})`);
          if (!by || by === r.requestedBy || (byId && byId === r.requestedById)) throw refuse('a purge is approved by a different person from the one who requested it');
          const ret = await readRetention(r.householdId);
          if (!ret || !ret.endedOn || ret.retentionUntil >= new Date().toISOString().slice(0, 10)) throw refuse(`the retention period of household ${r.householdId} has not ended`);
          const versions = (await readVersions(r.householdId)).length, auditEntries = (await readAudit(r.householdId)).length;
          await fsp.rm(hhDir(r.householdId), { recursive: true, force: true });
          await fsp.rm(path.join(retentionDir, r.householdId + '.json'), { force: true });
          const counts = { households: 1, versions, auditEntries, retention: 1 };
          Object.assign(r, { status: 'purged', decidedBy: by, decidedById: byId || null, decidedAt: new Date().toISOString(), note: note || '', counts });
          await writeRequest(r);
          return counts;
        },
      },
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
