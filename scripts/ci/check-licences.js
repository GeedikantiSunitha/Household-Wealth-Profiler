#!/usr/bin/env node
/* Every runtime package must carry a permissive open-source licence. A copyleft licence (GPL,
   AGPL, ...) would put obligations on each firm's deployment, and a package with no licence cannot
   legally be used at all. Development packages are not shipped and are not checked here.
   Usage: node scripts/ci/check-licences.js [root]     exits 1 with the problems on stderr.
   Checked by test/ci/guards.test.js. */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ALLOWED = ['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib'];

// The licence as the package declares it: a string, { type }, or the older licenses: [...]
function licenceOf(p) {
  if (typeof p.license === 'string') return p.license;
  if (p.license && typeof p.license.type === 'string') return p.license.type;
  if (Array.isArray(p.licenses)) return p.licenses.map(l => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
  return '';
}

// SPDX expressions: "A OR B" passes when either is allowed; "A AND B" needs both
function allowed(expr, allow) {
  const e = expr.replace(/[()]/g, ' ').trim();
  if (!e) return false;
  if (/\sOR\s/i.test(e)) return e.split(/\sOR\s/i).some(x => allowed(x, allow));
  if (/\sAND\s/i.test(e)) return e.split(/\sAND\s/i).every(x => allowed(x, allow));
  const id = e.replace(/\+$/, '').toLowerCase();
  return allow.some(a => a.toLowerCase() === id);
}

function checkLicences(packages, { allow = ALLOWED } = {}) {
  const problems = [];
  for (const p of packages) {
    const lic = licenceOf(p);
    if (!lic) problems.push(`${p.name}@${p.version} has no licence field`);
    else if (!allowed(lic, allow)) problems.push(`${p.name}@${p.version} has licence "${lic}", which is not in the allowed list`);
  }
  return { checked: packages.length, problems };
}

// The runtime packages npm installed under root (our own workspace packages are not third-party)
function fromNpm(root) {
  // Run npm's own script with this node, so no shell is involved on any platform
  const bin = path.dirname(process.execPath);
  const cli = [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(f => fs.existsSync(f));
  const [cmd, pre] = cli ? [process.execPath, [cli]] : ['npm', []];
  const out = execFileSync(cmd, [...pre, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' });
  const list = [];
  for (const line of out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    const dir = path.resolve(line);
    if (dir === path.resolve(root)) continue;
    if (!fs.realpathSync(dir).split(path.sep).includes('node_modules')) continue; // a workspace package of ours
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    list.push({ name: p.name, version: p.version, license: p.license, licenses: p.licenses });
  }
  return list;
}

module.exports = { checkLicences, fromNpm, ALLOWED };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  const { checked, problems } = checkLicences(fromNpm(root));
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`${checked} runtime package(s) checked: every licence is in the allowed list.`);
}
