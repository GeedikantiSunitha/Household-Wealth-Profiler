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
const { testDatabaseUrl } = require('./test-db.js');
const { waitForServer } = require('./servers.js');

const URL_ = testDatabaseUrl();
const ROOT = path.join(__dirname, '..', '..');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const node = args => execFileSync(process.execPath, ['server.js', ...args], { cwd: ROOT }).toString().trim();
const auth = (n, p) => ({ Authorization: 'Basic ' + Buffer.from(`${n}:${p}`).toString('base64') });
const SAM = auth('sam', 'correct horse'), CHRIS = auth('chris', 'battery staple');
const J = { 'Content-Type': 'application/json' };
let proc, db, KEY, ENV;

test.describe('PostgreSQL storage', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, () => {
  // A server that fails to start must fail the run in minutes, not hang it (seen on Windows)
  test.before(async () => {
    const { Client } = require('pg');
    db = new Client({ connectionString: URL_ });
    await db.connect();
    const left = (await db.query(`select count(*)::int n from information_schema.tables where table_schema = 'public' and table_name = 'households'`)).rows[0].n;
    if (left) throw new Error('TEST_DATABASE_URL must point at an empty database');
    KEY = node(['gen-key']);
    // DATABASE_OWNER_URL is blanked too: a developer's .env must never steer a test server's migrations elsewhere
    ENV = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: URL_, DATABASE_OWNER_URL: '', DATA_KEY: KEY, ALPHAVANTAGE_KEY: '',
      AUTH_USERS: [node(['hash-password', 'sam', 'correct horse']), node(['hash-password', 'chris', 'battery staple'])].join(';') };
    proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: ENV, stdio: 'pipe' });
    proc.stderr.on('data', d => serverLog.push(String(d))); // shown at the end if the server logged an error
    await waitForServer(proc, BASE);
  }, { timeout: 120000 });
  const serverLog = [];
  test.after(async () => {
    if (proc) proc.kill(); if (db) await db.end();
    const errors = serverLog.join('').split('\n').filter(l => /error/i.test(l) && !/applied migration/.test(l));
    if (errors.length) console.error('the test server logged errors during this run:\n' + errors.join('\n'));
  });

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

  test('two saves of the same version at once: exactly one wins, every time (25 rounds, never a server error)', async () => {
    for (let round = 1; round <= 25; round++) {
      const rec = await (await fetch(`${BASE}/api/households/${id}`, { headers: SAM })).json();
      const save = (who, v) => { const st = structuredClone(rec.state); st.household.reference = v; return fetch(`${BASE}/api/households/${id}`, { method: 'PUT', headers: { ...who, ...J }, body: JSON.stringify({ version: rec.version, state: st }) }); };
      const replies = await Promise.all([save(SAM, `A-${round}`), save(CHRIS, `B-${round}`)]);
      const codes = replies.map(r => r.status).sort();
      assert.deepEqual(codes, [200, 409], `round ${round}: ${await replies[codes.indexOf(500) >= 0 ? replies.findIndex(r => r.status === 500) : 0].text()}`);
    }
  });

  test('rows are encrypted and every version is kept', async () => {
    const h = (await db.query('select version, doc from households where id = $1', [id])).rows[0];
    // Sealed with the firm's own key (enc:v2); records from before tenancy are enc:v1 and still open
    const current = (await (await fetch(`${BASE}/api/households/${id}`, { headers: SAM })).json()).version;
    assert.ok(current >= 3);
    assert.equal(h.version, current); assert.match(h.doc, /^enc:v2:/); assert.doesNotMatch(h.doc, /Harrington/);
    const v = (await db.query('select version, doc from household_versions where household_id = $1 order by version', [id])).rows;
    assert.deepEqual(v.map(x => x.version), Array.from({ length: current }, (_, i) => i + 1), 'every version kept'); assert.ok(v.every(x => x.doc.startsWith('enc:v2:')));
    const firm = (await db.query('select wrapped_key from firms')).rows[0];
    assert.match(firm.wrapped_key, /^wk:v1:/, "the firm's key is stored wrapped");
    const a = (await db.query('select entry from audit_log where household_id = $1', [id])).rows;
    assert.ok(a.length >= 3); assert.ok(a.every(x => !/chris|bank/.test(x.entry)));
  });

  test('index-references fills the reference index for rows that lack it, and only those', async () => {
    await db.query('update households set reference_hmac = null where id = $1', [id]);
    const run = () => execFileSync(process.execPath, ['server.js', 'index-references'], { cwd: ROOT, env: ENV }).toString();
    assert.match(run(), /1 household\(s\) indexed/);
    const h = (await db.query('select reference_hmac from households where id = $1', [id])).rows[0];
    assert.match(h.reference_hmac, /^[0-9a-f]{64}$/);
    assert.match(run(), /0 household\(s\) indexed/);
  });

  test('create-user and set-password (as the owner): an account with a membership, a password from standard input, never on the command line', async () => {
    const { spawnSync } = require('node:child_process');
    const run = (args, input = '') => spawnSync(process.execPath, ['server.js', ...args], { cwd: ROOT, env: { ...ENV, DATABASE_OWNER_URL: URL_ }, input, encoding: 'utf8' });
    let r = run(['create-user', 'Dana@Example.com', 'Dana Adviser']);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Account created: [0-9a-f-]{36} \(adviser in firm f1a00000-0000-4000-8000-000000000001\)/);
    const u = (await db.query(`select id, email, name, password_hash from users where email = 'dana@example.com'`)).rows[0];
    assert.equal(u.name, 'Dana Adviser'); assert.equal(u.password_hash, null, 'no password yet');
    assert.equal((await db.query('select role from memberships where user_id = $1', [u.id])).rows[0].role, 'adviser');
    r = run(['create-user', 'dana@example.com', 'Dana Adviser', 'f1a00000-0000-4000-8000-000000000001', 'admin']);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Membership added to the existing account/);
    assert.equal((await db.query('select role from memberships where user_id = $1', [u.id])).rows[0].role, 'admin');
    assert.equal((await db.query(`select count(*)::int n from users where email = 'dana@example.com'`)).rows[0].n, 1, 'one account');
    r = run(['set-password', 'dana@example.com'], 'too short\n');
    assert.equal(r.status, 1); assert.match(r.stderr, /Use at least 12 characters/);
    r = run(['set-password', 'dana@example.com'], 'correct horse battery staple\n');
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'Password set for dana@example.com.');
    const h = (await db.query('select password_hash from users where id = $1', [u.id])).rows[0].password_hash;
    assert.match(h, /^scrypt\$131072\$8\$1\$/); assert.ok(!(r.stdout + r.stderr).includes('correct horse'), 'the password is never printed');
    assert.equal((await db.query(`select event from auth_events where user_id = $1`, [u.id])).rows[0].event, 'password_set');
    r = run(['set-password', 'nobody@example.com'], 'correct horse battery staple\n');
    assert.equal(r.status, 1); assert.match(r.stderr, /No account nobody@example.com/);
    r = run(['create-user', 'not-an-email', 'X']);
    assert.equal(r.status, 1); assert.match(r.stderr, /Usage/);
  });

  test('rotate-key re-wraps every firm key with NEW_DATA_KEY; a server with the new key reads everything', async () => {
    const run = (args, extra) => execFileSync(process.execPath, ['server.js', ...args], { cwd: ROOT, env: { ...ENV, DATABASE_OWNER_URL: URL_, ...extra }, encoding: 'utf8' }).trim();
    const before = (await db.query('select wrapped_key from firms')).rows[0].wrapped_key;
    const NEW = node(['gen-key']);
    assert.match(run(['rotate-key'], { NEW_DATA_KEY: NEW }), /1 firm key\(s\) re-wrapped/);
    const after = (await db.query('select wrapped_key from firms')).rows[0].wrapped_key;
    assert.notEqual(after, before); assert.match(after, /^wk:v1:/);
    // A fresh server with the new master key opens the records sealed before the rotation
    const p2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...ENV, DATA_KEY: NEW, PORT: String(PORT + 2) }, stdio: 'pipe' });
    try {
      const B2 = `http://127.0.0.1:${PORT + 2}`;
      await waitForServer(p2, B2);
      const rec = await (await fetch(`${B2}/api/households/${id}`, { headers: SAM })).json();
      assert.ok(rec.version >= 3, 'the record sealed before the rotation opens with the new key');
      assert.ok((await (await fetch(B2 + '/api/households', { headers: SAM })).json()).length >= 1);
    } finally { p2.kill(); }
    // The old master key no longer opens anything: a server with it cannot unwrap the firm key
    const p3 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...ENV, PORT: String(PORT + 3) }, stdio: 'pipe' });
    try {
      const B3 = `http://127.0.0.1:${PORT + 3}`;
      await waitForServer(p3, B3);
      assert.equal((await fetch(`${B3}/api/households/${id}`, { headers: SAM })).status, 500);
    } finally { p3.kill(); }
    // Rotate back, so the rest of this file (and the server started with the old key) carry on
    assert.match(run(['rotate-key'], { DATA_KEY: NEW, NEW_DATA_KEY: KEY }), /1 firm key\(s\) re-wrapped/);
    assert.match(run(['rotate-key'], { NEW_DATA_KEY: KEY }).toString(), /re-wrapped/, 'the same key again is harmless');
  });

  test('rotate-key refuses while any record is still sealed with the master key itself (enc:v1)', async () => {
    const { createSealer } = require('../../apps/api/src/crypto/seal.js');
    const legacy = createSealer(Buffer.from(KEY, 'base64'));
    const lid = crypto.randomUUID();
    const rec = { id: lid, version: 1, state: H.blank(), createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'old', updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'old' };
    rec.state.household.name = 'Legacy household';
    await db.query(`insert into households (id, version, doc, updated_at, firm_id) values ($1, 1, $2, now(), 'f1a00000-0000-4000-8000-000000000001')`, [lid, legacy.seal(JSON.stringify(rec))]);
    const r = require('node:child_process').spawnSync(process.execPath, ['server.js', 'rotate-key'], { cwd: ROOT, env: { ...ENV, DATABASE_OWNER_URL: URL_, NEW_DATA_KEY: node(['gen-key']) }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1 record\(s\) still sealed with DATA_KEY itself \(enc:v1\)/);
    assert.equal((await fetch(`${BASE}/api/households/${lid}`, { headers: SAM })).status, 200, 'the legacy record still reads');
  });

  test('a create whose transaction hits a deadlock or serialization failure is run again: one household, the Idempotency-Key honoured', async () => {
    for (const code of ['40P01', '40001']) {
      // A trigger that fails the first insert attempt only (a sequence counts attempts; sequences are not rolled back)
      await db.query(`create sequence retry_probe;
        create function fail_once() returns trigger language plpgsql as $$ begin
          if nextval('retry_probe') = 1 then raise exception 'simulated %', '${code}' using errcode = '${code}'; end if; return new; end $$;
        create trigger fail_once before insert on households for each row execute function fail_once()`);
      try {
        const before = (await (await fetch(BASE + '/api/households', { headers: SAM })).json()).length;
        const st = H.blank(); st.household.name = 'Retried after ' + code; st.household.reference = 'RETRY-' + code;
        const key = 'retry-' + crypto.randomUUID();
        const r1 = await fetch(BASE + '/api/households', { method: 'POST', headers: { ...SAM, ...J, 'Idempotency-Key': key }, body: JSON.stringify({ state: st }) });
        const j1 = await r1.json(); assert.equal(r1.status, 201, code + ' ' + JSON.stringify(j1));
        assert.equal((await db.query('select last_value::int n from retry_probe')).rows[0].n, 2, 'one failed attempt, then one that succeeded');
        const r2 = await fetch(BASE + '/api/households', { method: 'POST', headers: { ...SAM, ...J, 'Idempotency-Key': key }, body: JSON.stringify({ state: st }) });
        assert.equal(r2.status, 201); assert.deepEqual(await r2.json(), j1, 'the same key replays the reply from the retried create');
        assert.equal((await (await fetch(BASE + '/api/households', { headers: SAM })).json()).length, before + 1, 'exactly one household');
        assert.equal((await db.query('select count(*)::int n from households where id = $1', [j1.id])).rows[0].n, 1);
        assert.equal((await db.query(`select count(*)::int n from idempotency_keys where reply like '%' || $1 || '%'`, [j1.id])).rows[0].n, 1, 'one key row');
      } finally {
        await db.query('drop trigger if exists fail_once on households; drop function if exists fail_once(); drop sequence if exists retry_probe');
      }
    }
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
      await waitForServer(fileServer, FB);
      const st = H.sample(); st.household.name = 'Imported household';
      const { id: fid } = await (await fetch(FB + '/api/households', { method: 'POST', headers: { ...SAM, ...J }, body: JSON.stringify({ state: st }) })).json();
      st.household.reference = 'IMP-1';
      assert.equal((await fetch(`${FB}/api/households/${fid}`, { method: 'PUT', headers: { ...SAM, ...J }, body: JSON.stringify({ version: 1, state: st }) })).status, 200);
      // Firm settings saved twice on the file store
      const firm = (await (await fetch(FB + '/api/firm', { headers: SAM })).json()).settings;
      firm.firm.name = 'Imported Firm';
      assert.equal((await fetch(FB + '/api/firm', { method: 'PUT', headers: { ...SAM, ...J }, body: JSON.stringify({ version: 0, settings: firm }) })).status, 200);
      firm.firm.name = 'Imported Firm LLP';
      assert.equal((await fetch(FB + '/api/firm', { method: 'PUT', headers: { ...CHRIS, ...J }, body: JSON.stringify({ version: 1, settings: firm }) })).status, 200);
      const fileFirm = await (await fetch(FB + '/api/firm', { headers: SAM })).json();
      const fileFirmAudit = await (await fetch(FB + '/api/firm/audit', { headers: SAM })).json();
      fileServer.kill();

      const run = () => execFileSync(process.execPath, ['server.js', 'import-files', dir], { cwd: ROOT, env: ENV }).toString();
      const first = run();
      assert.match(first, /Copied 1 household/);
      assert.match(first, /Copied the firm settings \(2 version\(s\)\)/);
      const second = run();
      assert.match(second, /Copied 0 household\(s\) .* \(1 already/);
      assert.match(second, /Firm settings not copied: the database already has firm settings/);
      assert.deepEqual(await (await fetch(BASE + '/api/firm', { headers: SAM })).json(), fileFirm);
      assert.deepEqual(await (await fetch(BASE + '/api/firm/audit', { headers: SAM })).json(), fileFirmAudit);
      assert.equal((await db.query('select count(*)::int n from firm_record_versions')).rows[0].n, 2);
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
