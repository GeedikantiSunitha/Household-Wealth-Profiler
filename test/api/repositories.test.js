// apps/api/src/repositories: the file store and the PostgreSQL store must behave the same, so the
// same checks run against both. Files always; PostgreSQL when TEST_DATABASE_URL points at an empty
// scratch database (tables are created there and, by design, cannot be deleted afterwards).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, ID_RE } = require('../../apps/api/src/repositories');
const { createSealer } = require('../../apps/api/src/crypto/seal.js');

const ROOT = path.join(__dirname, '..', '..');
const sealer = createSealer(crypto.randomBytes(32));
const rec = (id, version, name, by = 'sam') => ({ id, version, state: { household: { name } }, createdAt: '2026-10-10T09:00:00.000Z', createdBy: 'sam', updatedAt: `2026-10-10T09:0${version}:00.000Z`, updatedBy: by });

function storeContract(label, makeStore, rawRows, rawFirm) {
  test.describe(`${label} store`, () => {
    let store; const id = crypto.randomUUID();
    test.before(async () => { store = await makeStore(); await store.init(); });
    test.after(async () => { if (store.end) await store.end(); });

    test('describe says where the data is', () => assert.match(store.describe, /^data in /));
    test('unknown household: get is null, audit is empty', async () => {
      assert.equal(await store.get(crypto.randomUUID()), null);
      assert.deepEqual(await store.audit(crypto.randomUUID()), []);
    });
    test('create, then get and list return it', async () => {
      await store.create(rec(id, 1, 'Alpha'), [{ ts: 't1', user: 'sam', field: 'created', from: '', to: 'Alpha' }]);
      assert.deepEqual(await store.get(id), rec(id, 1, 'Alpha'));
      assert.ok((await store.list()).some(r => r.id === id && r.version === 1));
    });
    test('update without "next" saves nothing and returns the result', async () => {
      let seen;
      assert.equal(await store.update(id, cur => { seen = cur; return { result: 'kept' }; }), 'kept');
      assert.equal(seen.version, 1);
      assert.equal((await store.get(id)).version, 1);
      assert.equal((await store.audit(id)).length, 1);
    });
    test('update with "next" saves the version and its audit entries together', async () => {
      const r = await store.update(id, cur => ({ result: cur.version + 1, next: rec(id, 2, 'Alpha 2', 'chris'),
        audit: [{ ts: 't2', user: 'chris', field: 'household.name', from: 'Alpha', to: 'Alpha 2', version: 2 }] }));
      assert.equal(r, 2);
      assert.deepEqual(await store.get(id), rec(id, 2, 'Alpha 2', 'chris'));
      assert.deepEqual((await store.audit(id)).map(a => a.field), ['household.name', 'created'], 'newest first');
    });
    test('update of an unknown household passes null to decide', async () => {
      assert.equal(await store.update(crypto.randomUUID(), cur => ({ result: cur })), null);
    });
    test('what is stored is encrypted: no readable names', async () => {
      const raw = await rawRows(id);
      assert.ok(raw.length >= 3, 'current, versions and audit are all stored');
      for (const text of raw) { assert.match(text, /^enc:v1:/); assert.doesNotMatch(text, /Alpha|chris|household\.name/); }
    });

    const firmRec = (version, name, by = 'sam') => ({ version, settings: { firm: { name } }, updatedAt: `2026-10-10T10:0${version}:00.000Z`, updatedBy: by });
    test('firm settings: none before the first save; decide sees null', async () => {
      assert.equal(await store.firm.get(), null);
      assert.deepEqual(await store.firm.audit(), []);
      assert.equal(await store.firm.update(cur => ({ result: cur })), null);
      assert.equal(await store.firm.get(), null, 'nothing saved without "next"');
    });
    test('firm settings: each save keeps the version and its audit entries, newest audit first', async () => {
      assert.equal(await store.firm.update(() => ({ result: 1, next: firmRec(1, 'Alder'), audit: [{ ts: 't1', user: 'sam', field: 'firm.name', from: '', to: 'Alder', version: 1 }] })), 1);
      assert.equal(await store.firm.update(cur => ({ result: cur.version + 1, next: firmRec(2, 'Alder LLP', 'chris'), audit: [{ ts: 't2', user: 'chris', field: 'firm.name', from: 'Alder', to: 'Alder LLP', version: 2 }] })), 2);
      assert.deepEqual(await store.firm.get(), firmRec(2, 'Alder LLP', 'chris'));
      assert.deepEqual((await store.firm.audit()).map(a => a.to), ['Alder LLP', 'Alder']);
      assert.ok((await store.list()).every(r => r.id && r.settings === undefined), 'never in the household list');
    });
    test('firm settings are encrypted where they are stored', async () => {
      const raw = await rawFirm();
      assert.equal(raw.length, 5, 'current, two versions and two audit entries');
      for (const text of raw) { assert.match(text, /^enc:v1:/); assert.doesNotMatch(text, /Alder|chris|firm\.name/); }
    });
  });
}

// File store: raw text = current.json, every version file, every audit line
let dir;
storeContract('file', () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-repo-')); return createStore({ dataDir: dir, databaseUrl: '' }, sealer); },
  async id => { const d = path.join(dir, 'households', id);
    return [fs.readFileSync(path.join(d, 'current.json'), 'utf8'), ...fs.readdirSync(path.join(d, 'versions')).map(f => fs.readFileSync(path.join(d, 'versions', f), 'utf8')),
      ...fs.readFileSync(path.join(d, 'audit.log'), 'utf8').split('\n').filter(Boolean)]; },
  async () => { const d = path.join(dir, 'households', 'firm');
    return [fs.readFileSync(path.join(d, 'current.json'), 'utf8'), ...fs.readdirSync(path.join(d, 'versions')).map(f => fs.readFileSync(path.join(d, 'versions', f), 'utf8')),
      ...fs.readFileSync(path.join(d, 'audit.log'), 'utf8').split('\n').filter(Boolean)]; });

test('file store: version files are kept, one per saved version', () => {
  const [hh] = fs.readdirSync(path.join(dir, 'households')).filter(x => ID_RE.test(x));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'households', hh, 'versions')).sort(), ['000001.json', '000002.json']);
});
test('household ids must be UUIDs', () => {
  assert.ok(ID_RE.test(crypto.randomUUID()));
  for (const bad of ['', 'not-an-id', '../../etc', crypto.randomUUID().toUpperCase()]) assert.ok(!ID_RE.test(bad), bad);
});

// PostgreSQL store: raw text = households.doc, household_versions.doc, audit_log.entry
const BASE_URL = process.env.TEST_DATABASE_URL;
if (BASE_URL) {
  const { Client } = require('pg');
  // test/api/postgres.test.js uses the same database at the same time, with its own key. Each run
  // here gets a schema of its own (dropped afterwards), so neither file sees the other's rows.
  const schema = 'hwp_repositories_' + crypto.randomBytes(4).toString('hex');
  const u = new URL(BASE_URL); u.searchParams.set('options', `-c search_path=${schema}`);
  const URL_ = u.toString();
  const admin = async sql => { const c = new Client({ connectionString: BASE_URL }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
  test.after(() => admin(`drop schema if exists ${schema} cascade`));
  storeContract('PostgreSQL', async () => { await admin(`create schema ${schema}`); return createStore({ databaseUrl: URL_, databasePoolMax: 2, root: ROOT }, sealer); }, async id => {
    const c = new Client({ connectionString: URL_ }); await c.connect();
    try {
      return [...(await c.query('select doc from households where id = $1', [id])).rows.map(r => r.doc),
        ...(await c.query('select doc from household_versions where household_id = $1', [id])).rows.map(r => r.doc),
        ...(await c.query('select entry as doc from audit_log where household_id = $1', [id])).rows.map(r => r.doc)];
    } finally { await c.end(); }
  }, async () => {
    const c = new Client({ connectionString: URL_ }); await c.connect();
    try {
      return [...(await c.query('select doc from firm_settings')).rows.map(r => r.doc),
        ...(await c.query('select doc from firm_versions')).rows.map(r => r.doc),
        ...(await c.query('select entry as doc from firm_audit')).rows.map(r => r.doc)];
    } finally { await c.end(); }
  });
} else {
  test('PostgreSQL store', { skip: 'set TEST_DATABASE_URL to run' }, () => {});
}
