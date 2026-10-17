// The backend runs one direction only: app.js -> middleware and routes -> controllers -> services
// -> repositories -> db. A file may require its own layer or a layer below it, never one above,
// and a route may not skip the controller to call a service. This reads every require() in
// backend/src and fails on the first edge that breaks the rule, naming the file.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', '..', 'backend', 'src');

// What each layer may require (its own layer is always allowed). The entry points (main.js, app.js,
// cli) wire everything, so they may require anything below them; routes name controllers and
// their guards; controllers call services; the lower layers never look up.
const ALLOWED = {
  'main.js': ['*'],
  'app.js': ['http', 'middleware', 'routes', 'repositories'],
  cli: ['services', 'repositories', 'crypto', 'db', 'config', 'middleware', 'http'],
  middleware: ['services', 'repositories'],
  routes: ['controllers', 'middleware', 'repositories'],
  controllers: ['services', 'repositories', 'crypto'],
  services: ['repositories', 'crypto', 'db'],
  repositories: ['db', 'crypto'],
  http: [],
  crypto: [],
  db: [],
  config: ['services'], // parses the SMTP_URL setting with the mail service's parser
};

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p); else if (e.name.endsWith('.js')) yield p;
  }
}
const layerOf = file => { const rel = path.relative(SRC, file).split(path.sep); return rel.length === 1 ? rel[0] : rel[0]; };
const targetLayer = (file, spec) => {
  const abs = path.resolve(path.dirname(file), spec);
  const rel = path.relative(SRC, abs).split(path.sep);
  if (rel[0] === '..') return null; // outside backend/src (packages/core, db/migrate.js): not a layer
  return rel.length === 1 ? rel[0].replace(/\.js$/, '') : rel[0];
};

test('every require() in backend/src points to the same layer or one below it', () => {
  const problems = [];
  for (const file of files(SRC)) {
    const layer = layerOf(file);
    const allowed = ALLOWED[layer];
    assert.ok(allowed, `${path.relative(SRC, file)}: the layer "${layer}" is not in the rule table; add it`);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/require\('(\.\.?\/[^']+)'\)/g)) {
      const target = targetLayer(file, m[1]);
      if (!target || target === layer || allowed.includes('*') || allowed.includes(target)) continue;
      problems.push(`${path.relative(SRC, file)} requires ${m[1]} (${layer} -> ${target})`);
    }
  }
  assert.deepEqual(problems, [], 'edges that break the one-direction rule');
});
