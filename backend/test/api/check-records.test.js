// node server.js check-records: reports every stored household and firm settings record that the
// field rules (backend/src/services/validate.js) would refuse, and every record that cannot be
// read, without changing anything. Run on a database before the rules are enforced on it. Output
// names ids, field paths and rules only, never a stored value. Exit 0 clean, 2 with problems.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../../../packages/core/core.js');
const { createStore, DEFAULT_FIRM_ID } = require('../../../backend/src/repositories');
const { createSealer } = require('../../../backend/src/crypto/seal.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const OTHER_FIRM = '0f1e0000-0000-4000-8000-000000000002';
const KEY = crypto.randomBytes(32).toString('base64');
const rec = (id, state) => ({ id, version: 1, state, createdAt: '2026-10-10T09:00:00.000Z', createdBy: 'sam', updatedAt: '2026-10-10T09:00:00.000Z', updatedBy: 'sam' });
const run = (dir, args = []) => new Promise(resolve => execFile(process.execPath, ['server.js', 'check-records', ...args],
  { cwd: ROOT, timeout: 20000, env: { ...process.env, DATA_DIR: dir, DATA_KEY: KEY, DATABASE_URL: '', DATABASE_OWNER_URL: '', SMTP_URL: '', SMTP_FROM: '', OPERATOR_EMAIL: '', DB_LOGIN_MODE: '', PUBLIC_URL: '' } },
  (error, stdout, stderr) => resolve({ code: error ? (error.code === undefined ? 'killed' : error.code) : 0, stdout, stderr })));

test('check-records lists each record the rules would refuse and each unreadable one, per firm, and changes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-check-'));
  const store = createStore({ dataDir: dir, databaseUrl: '' }, createSealer(Buffer.from(KEY, 'base64')));
  await store.init();
  const a = store.forFirm(DEFAULT_FIRM_ID), b = store.forFirm(OTHER_FIRM);
  const good = crypto.randomUUID(), bad = crypto.randomUUID(), broken = crypto.randomUUID(), other = crypto.randomUUID();
  await a.create(rec(good, H.normalise(H.sample())), []);
  const s = H.normalise(H.blank()); s.household.name = 'Bad values'; s.members = [{ ...H.defaults('members'), dob: 'SECRET-DATE' }]; s.accounts = [{ ...H.defaults('accounts'), value: 'SECRET-VALUE' }];
  await a.create(rec(bad, s), []);
  await a.create(rec(broken, H.normalise(H.blank())), []);
  fs.writeFileSync(path.join(dir, 'households', broken, 'current.json'), 'enc:v1:garbage');
  const f = H.firmNormalise(H.firmBlank()); f.team = [{ ...H.defaults('team'), name: 'Alex', role: 'SECRET-ROLE' }];
  await a.firm.update(() => ({ next: { version: 1, settings: f, updatedAt: '2026-10-10T09:00:00.000Z', updatedBy: 'sam' }, audit: [], result: 1 }));
  const o = H.normalise(H.blank()); o.household.region = 'SECRET-REGION';
  await b.create(rec(other, o), []);
  const before = fs.readdirSync(path.join(dir, 'households')).sort();

  const r = await run(dir);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  const lines = r.stdout.split('\n').map(l => l.trimEnd());
  assert.ok(lines.includes(`Firm ${DEFAULT_FIRM_ID}: 3 household(s) checked, 1 with problems, 1 unreadable; firm settings: 1 problem(s)`), r.stdout);
  assert.ok(lines.includes(`  ${bad}: members[0].dob must be a date (YYYY-MM-DD)`), r.stdout);
  assert.ok(lines.includes(`  ${bad}: accounts[0].value must be a number`), r.stdout);
  assert.ok(lines.includes(`  ${broken}: unreadable (a wrong key or a damaged record)`), r.stdout);
  assert.ok(lines.includes('  firm settings: team[0].role must be one of the listed options'), r.stdout);
  assert.ok(lines.includes(`Firm ${OTHER_FIRM}: 1 household(s) checked, 1 with problems, 0 unreadable; firm settings: none saved`), r.stdout);
  assert.ok(lines.includes(`  ${other}: household.region must be one of the listed options`), r.stdout);
  assert.ok(lines.includes('5 problem(s) in 4 record(s) across 2 firm(s). Nothing was changed.'), r.stdout);
  assert.ok(!/SECRET|Bad values|Harrington/.test(r.stdout + r.stderr), 'no stored value or name appears in the report');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'households')).sort(), before, 'nothing was added or removed');
  assert.equal(fs.readFileSync(path.join(dir, 'households', broken, 'current.json'), 'utf8'), 'enc:v1:garbage', 'the unreadable record is left as it is');

  // One firm only, by id
  const one = await run(dir, [OTHER_FIRM]);
  assert.equal(one.code, 2); assert.ok(!one.stdout.includes(DEFAULT_FIRM_ID), 'only the named firm');
  if (store.end) await store.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('check-records on a clean data folder: exit 0 and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-check-'));
  const store = createStore({ dataDir: dir, databaseUrl: '' }, createSealer(Buffer.from(KEY, 'base64')));
  await store.init();
  await store.forFirm(DEFAULT_FIRM_ID).create(rec(crypto.randomUUID(), H.normalise(H.sample())), []);
  const r = await run(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No problems found: 1 record\(s\) across 1 firm\(s\)\. Nothing was changed\./);
  if (store.end) await store.end();
  fs.rmSync(dir, { recursive: true, force: true });
});
