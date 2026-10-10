// PostgreSQL storage: starts a real server with DATABASE_URL pointing at an empty database.
// Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgres://postgres:secret@localhost:5432/hwp_test npm test
// The database's tables are created by the server and left behind (they cannot be deleted by design),
// so use a scratch database and drop it afterwards.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../../packages/core/core.js');
const { apiContract } = require('./api-contract.js');

const URL_ = process.env.TEST_DATABASE_URL;
const ROOT = path.join(__dirname, '..', '..');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const node = args => execFileSync(process.execPath, ['server.js', ...args], { cwd: ROOT }).toString().trim();
const auth = (n, p) => ({ Authorization: 'Basic ' + Buffer.from(`${n}:${p}`).toString('base64') });
const SAM = auth('sam', 'correct horse'), CHRIS = auth('chris', 'battery staple');
const J = { 'Content-Type': 'application/json' };
let proc, db, KEY, ENV;

test.describe('PostgreSQL storage', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, () => {
  test.before(async () => {
    const { Client } = require('pg');
    db = new Client({ connectionString: URL_ });
    await db.connect();
    const left = (await db.query(`select count(*)::int n from information_schema.tables where table_schema = 'public' and table_name = 'households'`)).rows[0].n;
    if (left) throw new Error('TEST_DATABASE_URL must point at an empty database');
    KEY = node(['gen-key']);
    ENV = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: URL_, DATA_KEY: KEY,
      AUTH_USERS: [node(['hash-password', 'sam', 'correct horse']), node(['hash-password', 'chris', 'battery staple'])].join(';') };
    proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: ENV, stdio: 'pipe' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    throw new Error('server did not start');
  });
  test.after(async () => { if (proc) proc.kill(); if (db) await db.end(); });

  let id;
  test('create, save, version conflict and audit trail', async () => {
    let r = await fetch(BASE + '/api/households', { method: 'POST', headers: { ...SAM, ...J }, body: JSON.stringify({ state: H.sample() }) });
    assert.equal(r.status, 201); ({ id } = await r.json());
    const rec = await (await fetch(`${BASE}/api/households/${id}`, { headers: SAM })).json();
    assert.equal(rec.version, 1); assert.equal(rec.state.household.name, 'Harrington household');

    const st = rec.state; st.members[1].poaType = 'bank';
    r = await fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...CHRIS, ...J }, body: JSON.stringify({ version: 1, state: st }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).version, 2);
    r = await fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...SAM, ...J }, body: JSON.stringify({ version: 1, state: st }) });
    assert.equal(r.status, 409);

    const audit = await (await fetch(`${BASE}/api/households/${id}/audit`, { headers: SAM })).json();
    assert.equal(audit[0].field, 'members[1].poaType'); assert.equal(audit[0].user, 'chris');
    assert.equal(audit[audit.length - 1].field, 'created');
    const list = await (await fetch(BASE + '/api/households', { headers: SAM })).json();
    assert.equal(list.length, 1); assert.equal(list[0].version, 2); assert.equal(list[0].updatedBy, 'chris');
    assert.equal((await fetch(`${BASE}/api/households/${crypto.randomUUID()}`, { headers: SAM })).status, 404);
  });

  test('two saves of the same version at once: exactly one wins', async () => {
    const rec = await (await fetch(`${BASE}/api/households/${id}`, { headers: SAM })).json();
    const save = (who, v) => { const st = structuredClone(rec.state); st.household.reference = v; return fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...who, ...J }, body: JSON.stringify({ version: rec.version, state: st }) }); };
    const codes = (await Promise.all([save(SAM, 'A-1'), save(CHRIS, 'B-2')])).map(r => r.status).sort();
    assert.deepEqual(codes, [200, 409]);
  });

  test('rows are encrypted and every version is kept', async () => {
    const h = (await db.query('select version, doc from households where id = $1', [id])).rows[0];
    assert.equal(h.version, 3); assert.match(h.doc, /^enc:v1:/); assert.doesNotMatch(h.doc, /Harrington/);
    const v = (await db.query('select version, doc from household_versions where household_id = $1 order by version', [id])).rows;
    assert.deepEqual(v.map(x => x.version), [1, 2, 3]); assert.ok(v.every(x => x.doc.startsWith('enc:v1:')));
    const a = (await db.query('select entry from audit_log where household_id = $1', [id])).rows;
    assert.ok(a.length >= 3); assert.ok(a.every(x => !/chris|bank/.test(x.entry)));
  });

  test('the database refuses deletes and rewrites', async () => {
    for (const sql of ['delete from households', 'delete from household_versions', 'update household_versions set doc = $$x$$', 'delete from audit_log', 'update audit_log set entry = $$x$$', 'truncate audit_log cascade']) {
      await assert.rejects(db.query(sql), /not allowed: records are kept/, sql);
    }
  });

  test('import-files copies a file-store household with its history, once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-import-'));
    const fileServer = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...ENV, DATABASE_URL: '', DATA_DIR: dir, PORT: String(PORT + 1) }, stdio: 'pipe' });
    try {
      const FB = `http://127.0.0.1:${PORT + 1}`;
      for (let i = 0; i < 50; i++) { try { if ((await fetch(FB + '/healthz')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
      const st = H.sample(); st.household.name = 'Imported household';
      const { id: fid } = await (await fetch(FB + '/api/households', { method: 'POST', headers: { ...SAM, ...J }, body: JSON.stringify({ state: st }) })).json();
      st.household.reference = 'IMP-1';
      assert.equal((await fetch(`${FB}/api/households/${fid}`, { method: 'PUT', headers: { ...SAM, ...J }, body: JSON.stringify({ version: 1, state: st }) })).status, 200);
      fileServer.kill();

      const run = () => execFileSync(process.execPath, ['server.js', 'import-files', dir], { cwd: ROOT, env: ENV }).toString();
      assert.match(run(), /Copied 1 household/);
      assert.match(run(), /Copied 0 household\(s\) .* \(1 already/);
      const rec = await (await fetch(`${BASE}/api/households/${fid}`, { headers: SAM })).json();
      assert.equal(rec.version, 2); assert.equal(rec.state.household.reference, 'IMP-1');
      const audit = await (await fetch(`${BASE}/api/households/${fid}/audit`, { headers: SAM })).json();
      assert.equal(audit[0].field, 'household.reference'); assert.equal(audit[audit.length - 1].field, 'created');
      assert.equal((await db.query('select count(*)::int n from household_versions where household_id = $1', [fid])).rows[0].n, 2);
    } finally { fileServer.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // PostgreSQL storage held to the same API contract as file storage
  apiContract(() => ({ base: BASE, sam: SAM, chris: CHRIS }));
});
