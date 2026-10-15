// The front end runs one direction only: pages -> components -> hooks -> services/api, with lib
// and content below everything. Only services/api talks to the server: no other browser module
// may call fetch. This reads every import in apps/web/public/js (static, side-effect and dynamic)
// and fails on the first edge that breaks the rule, naming the file.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS = path.join(__dirname, '..', '..', 'apps', 'web', 'public', 'js');

// What each folder may import (its own folder is always allowed). main.js and events/ are the
// shell that wires everything, so they may import anything.
const ALLOWED = {
  'main.js': ['*'],
  events: ['*'],
  pages: ['components', 'hooks', 'services', 'lib', 'content'],
  components: ['hooks', 'lib', 'content'],
  hooks: ['services', 'lib', 'content'],
  services: ['lib'],
  lib: [],
  content: [],
};

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p); else if (e.name.endsWith('.js')) yield p;
  }
}
const folderOf = file => path.relative(JS, file).split(path.sep)[0];
const IMPORT = /(?:from\s*'|import\s*'|import\(\s*')(\.\.?\/[^']+)'/g;

test('every import in apps/web/public/js points to the same folder or one below it', () => {
  const problems = [];
  for (const file of files(JS)) {
    const folder = folderOf(file);
    const allowed = ALLOWED[folder];
    assert.ok(allowed, `${path.relative(JS, file)}: the folder "${folder}" is not in the rule table; add it`);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const target = folderOf(path.resolve(path.dirname(file), m[1]));
      if (target === folder || allowed.includes('*') || allowed.includes(target)) continue;
      problems.push(`${path.relative(JS, file)} imports ${m[1]} (${folder} -> ${target})`);
    }
  }
  assert.deepEqual(problems, [], 'imports that break the one-direction rule');
});

test('only services/api calls the server: no other browser module calls fetch', () => {
  const callers = [];
  for (const file of files(JS)) {
    if (/\bfetch\s*\(/.test(fs.readFileSync(file, 'utf8'))) callers.push(path.relative(JS, file).split(path.sep).join('/'));
  }
  assert.deepEqual(callers.sort(), ['services/api/auth.js', 'services/api/client.js']);
});
