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
const { createStore, ID_RE, DEFAULT_FIRM_ID } = require('../../apps/api/src/repositories');
const { createSealer } = require('../../apps/api/src/crypto/seal.js');

const ROOT = path.join(__dirname, '..', '..');
const sealer = createSealer(crypto.randomBytes(32));
const OTHER_FIRM = '0f1e0000-0000-4000-8000-000000000002';
const rec = (id, version, name, by = 'sam') => ({ id, version, state: { household: { name, reference: 'R-' + id.slice(0, 8) } }, createdAt: '2026-10-10T09:00:00.000Z', createdBy: 'sam', updatedAt: `2026-10-10T09:0${version}:00.000Z`, updatedBy: by });

// hooks: corrupt(id) makes a stored record unreadable; ageKeys(hours) backdates every idempotency key
function storeContract(label, makeStore, rawRows, rawFirm, hooks) {
  test.describe(`${label} store`, () => {
    let root, store; const id = crypto.randomUUID();
    test.before(async () => { root = await makeStore(); await root.init(); store = root.forFirm(DEFAULT_FIRM_ID); });
    test.after(async () => { if (root.end) await root.end(); });

    test('describe says where the data is', () => assert.match(root.describe, /^data in /));
    test('unknown household: get is null, audit is empty', async () => {
      assert.equal(await store.get(crypto.randomUUID()), null);
      assert.deepEqual(await store.audit(crypto.randomUUID()), []);
    });
    test('create, then get and list return it', async () => {
      assert.deepEqual(await store.create(rec(id, 1, 'Alpha'), [{ ts: 't1', user: 'sam', field: 'created', from: '', to: 'Alpha' }]), { id, version: 1 });
      assert.deepEqual(await store.get(id), rec(id, 1, 'Alpha'));
      assert.ok((await store.list()).some(r => r.id === id && r.version === 1));
    });
    test('create with an idempotency key: the same user and key again returns the first reply and stores nothing new', async () => {
      const a = crypto.randomUUID(), b = crypto.randomUUID();
      assert.deepEqual(await store.create(rec(a, 1, 'Once'), [], { user: 'sam', key: 'key-000001' }), { id: a, version: 1 });
      assert.deepEqual(await store.create(rec(b, 1, 'Twice'), [], { user: 'sam', key: 'key-000001' }), { id: a, version: 1 }, 'the first reply again');
      assert.equal(await store.get(b), null, 'no second household');
      assert.equal((await store.create(rec(b, 1, 'Other user'), [], { user: 'chris', key: 'key-000001' })).id, b, 'keys are per user');
    });
    test('an idempotency key older than 24 hours no longer replays', async () => {
      const a = crypto.randomUUID(), b = crypto.randomUUID();
      await store.create(rec(a, 1, 'Old'), [], { user: 'sam', key: 'key-000002' });
      await hooks.ageKeys(25);
      assert.equal((await store.create(rec(b, 1, 'New'), [], { user: 'sam', key: 'key-000002' })).id, b);
    });
    test('list skips a record that cannot be read and reports its id; get on it fails', async () => {
      const bad = crypto.randomUUID();
      await store.create(rec(bad, 1, 'Soon unreadable'), []);
      await hooks.corrupt(bad);
      const seen = [];
      const list = await store.list({ onUnreadable: (rid, e) => seen.push([rid, e instanceof Error]) });
      assert.ok(list.some(r => r.id === id), 'the readable record is still listed');
      assert.ok(!list.some(r => r.id === bad), 'the unreadable one is left out');
      assert.deepEqual(seen, [[bad, true]]);
      await assert.rejects(store.get(bad));
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
    test('the reference index: found by its normalised reference within the firm, not by another spelling', async () => {
      const h = await store.indexReference('  r-' + id.slice(0, 8).toUpperCase() + ' ');
      assert.match(h, /^[0-9a-f]{64}$/);
      assert.equal(await store.findByReference(h), id);
      assert.equal(await store.findByReference(await store.indexReference('R-nothing')), null);
      assert.equal(await store.indexReference(''), null);
    });
    test('another firm sees none of it: get, list, audit, versions, update, reference, firm settings', async () => {
      await hooks.addFirm(OTHER_FIRM); // a firm exists before it has a store (PostgreSQL: a firms row; files: nothing needed)
      const other = root.forFirm(OTHER_FIRM);
      assert.equal(await other.get(id), null);
      assert.deepEqual(await other.list(), []);
      assert.deepEqual(await other.audit(id), []);
      assert.deepEqual(await other.versions(id), []);
      assert.equal(await other.update(id, cur => ({ result: cur, next: cur && rec(id, 9, 'Stolen', 'eve') })), null);
      assert.equal((await store.get(id)).version, 2, 'untouched');
      assert.equal(await other.findByReference(await other.indexReference('R-' + id.slice(0, 8))), null, 'the index is per firm');
      assert.equal(await other.firm.get(), null);
      const own = crypto.randomUUID();
      await other.create(rec(own, 1, 'Theirs'), []);
      assert.equal(await store.get(own), null, 'and the default firm sees nothing of theirs');
      assert.deepEqual((await other.list()).map(r => r.id), [own]);
    });
    test('what is stored is encrypted: no readable names', async () => {
      const raw = await rawRows(id);
      assert.ok(raw.length >= 3, 'current, versions and audit are all stored');
      for (const text of raw) { assert.match(text, /^enc:v(1|2):/); assert.doesNotMatch(text, /Alpha|chris|household\.name/); }
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
      for (const text of raw) { assert.match(text, /^enc:v(1|2):/); assert.doesNotMatch(text, /Alder|chris|firm\.name/); }
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
      ...fs.readFileSync(path.join(d, 'audit.log'), 'utf8').split('\n').filter(Boolean)]; },
  { corrupt: async rid => fs.writeFileSync(path.join(dir, 'households', rid, 'current.json'), 'enc:v1:garbage'),
    ageKeys: async hours => { const d = path.join(dir, 'idempotency'); const t = new Date(Date.now() - hours * 3600e3); for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), t, t); },
    addFirm: async () => {} });

test('file store: version files are kept, one per saved version; the default firm keeps the original layout, other firms live under firms/', () => {
  const versions = fs.readdirSync(path.join(dir, 'households')).filter(x => ID_RE.test(x)).map(h => fs.readdirSync(path.join(dir, 'households', h, 'versions')).sort());
  assert.ok(versions.some(v => v.join() === '000001.json,000002.json'), 'the household saved twice has two version files');
  assert.ok(versions.every(v => v[0] === '000001.json'), 'every household starts at version 1');
  assert.equal(fs.readdirSync(path.join(dir, 'firms', OTHER_FIRM, 'households')).filter(x => ID_RE.test(x)).length, 1, 'the other firm has its own folder');
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
      return [...(await c.query('select doc from firm_records')).rows.map(r => r.doc),
        ...(await c.query('select doc from firm_record_versions')).rows.map(r => r.doc),
        ...(await c.query('select entry as doc from firm_audit')).rows.map(r => r.doc)];
    } finally { await c.end(); }
  }, {
    corrupt: async rid => { const c = new Client({ connectionString: URL_ }); await c.connect(); try { await c.query(`update households set doc = 'enc:v1:garbage' where id = $1`, [rid]); } finally { await c.end(); } },
    ageKeys: async hours => { const c = new Client({ connectionString: URL_ }); await c.connect(); try { await c.query(`update idempotency_keys set created_at = now() - ($1 || ' hours')::interval`, [String(hours)]); } finally { await c.end(); } },
    addFirm: async fid => { const c = new Client({ connectionString: URL_ }); await c.connect(); try { await c.query(`insert into firms (id, name) values ($1, 'Other firm') on conflict do nothing`, [fid]); } finally { await c.end(); } },
  });
} else {
  test('PostgreSQL store', { skip: 'set TEST_DATABASE_URL to run' }, () => {});
}
