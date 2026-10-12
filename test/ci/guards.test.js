// Change-control guards that CI runs on every pull request:
//   scripts/ci/check-migrations.js  migrations may only add; nothing is dropped, deleted or truncated
//   scripts/ci/check-licences.js    every runtime package carries an allowed open-source licence
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkMigrations } = require('../../scripts/ci/check-migrations.js');
const { checkLicences, fromNpm } = require('../../scripts/ci/check-licences.js');

const ROOT = path.join(__dirname, '..', '..');
const write = (dir, files) => { for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text); return dir; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-guard-'));

test.describe('migrations may only add', () => {
  test('the real migrations pass', () => {
    assert.deepEqual(checkMigrations(path.join(ROOT, 'db', 'migrations')).problems, []);
  });
  test('creating tables, indexes and the no-delete triggers is fine', () => {
    const dir = write(tmp(), { '0001_a.sql': `create table a (x int);\ncreate index a_x on a (x);\n/* a comment that says drop table */\ncreate or replace trigger a_no_delete before delete on a for each row execute function refuse_change();\ncreate or replace trigger a_no_truncate before truncate on a execute function refuse_change();\n-- drop table a; (commented out)\n` });
    assert.deepEqual(checkMigrations(dir), { files: 1, problems: [] });
  });
  test('drop, delete, truncate and dropping a column are refused, naming the file and the statement', () => {
    const dir = write(tmp(), {
      '0001_a.sql': 'create table a (x int);\n',
      '0002_b.sql': 'drop table a;\n',
      '0003_c.sql': 'delete from a where x = 1;\n',
      '0004_d.sql': 'alter table a drop column x;\n',
      '0005_e.sql': 'truncate a;\n',
      '0006_f.sql': 'create function purge() returns void language plpgsql as $$\nbegin\n  delete from a;\nend $$;\n',
    });
    const { problems } = checkMigrations(dir);
    assert.equal(problems.length, 5);
    for (const [file, word] of [['0002_b.sql', 'drop'], ['0003_c.sql', 'delete'], ['0004_d.sql', 'alter table'], ['0005_e.sql', 'truncate'], ['0006_f.sql', 'delete']]) {
      assert.ok(problems.some(p => p.includes(file) && p.toLowerCase().includes(word)), `${file}: ${problems.join(' | ')}`);
    }
  });
  test('a destructive statement is allowed only with a reason on the line before it', () => {
    const dir = write(tmp(), {
      '0001_a.sql': '-- allow-destructive: approved erasure after the retention period (decision 0004)\ndelete from a where retention_until < now();\n',
      '0002_b.sql': '-- allow-destructive:\ndelete from a;\n',
    });
    const { problems } = checkMigrations(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /0002_b\.sql/);
  });
  test('files must be numbered NNNN_name.sql with no duplicate numbers', () => {
    const dir = write(tmp(), { '0001_a.sql': 'create table a (x int);\n', '0001_b.sql': 'create table b (x int);\n', 'notes.sql': 'create table c (x int);\n' });
    const { problems } = checkMigrations(dir);
    assert.ok(problems.some(p => /notes\.sql/.test(p)));
    assert.ok(problems.some(p => /0001/.test(p) && /twice|duplicate/i.test(p)));
  });
  test('the command exits 1 and prints the problems', () => {
    const dir = write(tmp(), { '0001_a.sql': 'drop table a;\n' });
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-migrations.js'), dir], { stdio: 'pipe' }),
      e => e.status === 1 && /0001_a\.sql/.test(String(e.stderr)));
    const ok = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-migrations.js'), path.join(ROOT, 'db', 'migrations')]).toString();
    assert.match(ok, /migration file\(s\) only add/);
  });
});

test.describe('runtime packages carry an allowed licence', () => {
  const pkgs = [
    { name: 'a', version: '1.0.0', license: 'MIT' },
    { name: 'b', version: '2.0.0', license: 'GPL-3.0-only' },
    { name: 'c', version: '1.0.0', license: '(MIT OR Apache-2.0)' },
    { name: 'd', version: '1.0.0', license: '(GPL-2.0-only AND MIT)' },
    { name: 'e', version: '1.0.0' },
    { name: 'f', version: '1.0.0', licenses: [{ type: 'BSD-3-Clause' }] },
    { name: 'g', version: '1.0.0', license: { type: 'ISC' } },
  ];
  test('permissive licences pass; copyleft, "AND" with copyleft, and missing licences are refused', () => {
    const { checked, problems } = checkLicences(pkgs);
    assert.equal(checked, 7);
    assert.deepEqual(problems.map(p => p.split(' ')[0]).sort(), ['b@2.0.0', 'd@1.0.0', 'e@1.0.0']);
    assert.ok(problems.find(p => p.startsWith('e@')).includes('no licence'));
  });
  test('the allow-list can be replaced', () => {
    assert.equal(checkLicences(pkgs, { allow: ['GPL-3.0-only'] }).problems.length, 6);
  });
  test("the project's own runtime packages all pass", () => {
    const list = fromNpm(ROOT);
    assert.ok(list.length >= 10, 'npm ls found the runtime packages');
    assert.ok(list.every(p => p.name && p.version), 'each has a name and version');
    assert.ok(!list.some(p => p.name === '@hwp/core'), 'our own workspace package is not checked against the allow-list');
    assert.deepEqual(checkLicences(list).problems, []);
  });
  test('the command exits 0 for the project and prints what it checked', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-licences.js')], { cwd: ROOT }).toString();
    assert.match(out, /runtime package\(s\) checked/);
  });
});
