// backend/.env.example lists every setting the back end reads, so the file a person copies (or the
// list they enter on DCDeploy) cannot fall behind the code; and the back end reads its own .env file.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { envFileOf, load } = require('../../src/config');

const BACKEND = path.join(__dirname, '..', '..');
// Variables the back end sets for a child process (pg_dump, pg_restore), not settings anyone gives it
const NOT_SETTINGS = new Set(['PGPASSWORD', 'PGSSLMODE', 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE']);

function settingsRead() {
  const names = new Set();
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!f.name.endsWith('.js')) continue;
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
      for (const m of s.matchAll(/\bminutes\('([A-Z][A-Z0-9_]+)'/g)) names.add(m[1]);
    }
  })(path.join(BACKEND, 'src'));
  return [...names].filter(n => !NOT_SETTINGS.has(n)).sort();
}

test('every setting the back end reads is in backend/.env.example', () => {
  const doc = fs.readFileSync(path.join(BACKEND, '.env.example'), 'utf8');
  const read = settingsRead();
  assert.ok(read.length >= 25, `found ${read.length} settings: the scan works`);
  const missing = read.filter(n => !new RegExp(`^#?\\s*${n}=`, 'm').test(doc));
  assert.deepEqual(missing, [], 'add these to backend/.env.example with what they mean');
});

test('the back end reads backend/.env when it exists, else the project root .env (one file, never both)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-envfile-'));
  try {
    const KEY = Buffer.alloc(32, 1).toString('base64');
    fs.writeFileSync(path.join(root, '.env'), `DATA_KEY=${KEY}\nDATABASE_URL=postgres://root-file/db\nRETENTION_YEARS=7\n`);
    assert.equal(envFileOf(root), path.join(root, '.env'));
    assert.equal(load({ env: {}, root }).databaseUrl, 'postgres://root-file/db', 'without backend/.env, the root file as before');
    fs.mkdirSync(path.join(root, 'backend'));
    fs.writeFileSync(path.join(root, 'backend', '.env'), `DATA_KEY=${KEY}\nDATABASE_URL=postgres://backend-file/db\n`);
    assert.equal(envFileOf(root), path.join(root, 'backend', '.env'));
    const c = load({ env: {}, root });
    assert.equal(c.databaseUrl, 'postgres://backend-file/db', 'backend/.env wins');
    assert.equal(c.retentionYears, 5, 'and the root file is not read at all: nothing comes from two places');
    assert.equal(load({ env: { DATABASE_URL: 'postgres://environment/db' }, root }).databaseUrl, 'postgres://environment/db', 'the environment wins over either file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
