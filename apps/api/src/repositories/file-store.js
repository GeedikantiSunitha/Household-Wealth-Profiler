/* Households as files under one folder (the default when DATABASE_URL is not set):
     households/<id>/current.json        the current record
     households/<id>/versions/NNNNNN.json every saved version
     households/<id>/audit.log           one sealed audit entry per line, oldest first
     households/firm/...                 the firm settings, in the same three forms (the list only
                                         reads folders named by a household id, so it never shows)
   Records and audit entries are sealed (encrypted when DATA_KEY is set) before they are written.
   Writes go to a temporary file first and are then renamed, so a crash never leaves half a file. */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { ID_RE } = require('./ids.js');

function createFileStore(dir, { seal, open }) {
  const hhDir = id => path.join(dir, 'households', id);
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
  // Firm settings: one record beside the households, written the same way (version file, then current)
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
  async function ids() {
    try { return (await fsp.readdir(path.join(dir, 'households'))).filter(x => ID_RE.test(x)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  return {
    describe: 'data in ' + dir,
    async init() { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
    ids,
    async list() { const out = []; for (const id of await ids()) { const rec = await readRecord(id); if (rec) out.push(rec); } return out; },
    get: readRecord,
    versions: readVersions,
    async create(rec, audit) { await writeRecord(rec); await appendAudit(rec.id, audit); },
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

module.exports = { createFileStore };
