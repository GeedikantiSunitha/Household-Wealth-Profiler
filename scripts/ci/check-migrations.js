#!/usr/bin/env node
/* Migrations may only add. Records are kept for regulatory retention (MLR 2017), so a routine
   change never drops, deletes or truncates anything in the database. A statement that has to be
   destructive (for example an approved erasure after the retention period) is allowed only with a
   reason on the line before it:
     -- allow-destructive: <why, and who approved it>
   Usage: node scripts/ci/check-migrations.js [dir]     exits 1 with the problems on stderr.
   Checked by test/ci/guards.test.js. */
'use strict';
const fs = require('fs');
const path = require('path');

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
// A line that starts a destructive statement. "before delete on" / "before truncate on" are the
// retention triggers themselves and are not statements that delete anything.
const DESTRUCTIVE = /^(drop\b|delete\s+from\b|truncate\b(?!\s+on\b)|alter\s+table\b.*\bdrop\b)/i;
const ALLOW = /^\s*--\s*allow-destructive:\s*\S/i;

function checkFile(file, text) {
  const problems = [];
  let inBlock = false, allowNext = false;
  text.split('\n').forEach((raw, i) => {
    if (ALLOW.test(raw)) { allowNext = true; return; }
    // Strip comments: a block comment may span lines; a line comment runs to the end of the line
    let line = raw;
    if (inBlock) { const end = line.indexOf('*/'); if (end < 0) return; line = line.slice(end + 2); inBlock = false; }
    for (;;) { const s = line.indexOf('/*'); if (s < 0) break; const e = line.indexOf('*/', s + 2); if (e < 0) { line = line.slice(0, s); inBlock = true; break; } line = line.slice(0, s) + line.slice(e + 2); }
    line = line.replace(/--.*$/, '').trim();
    if (!line) return;
    if (DESTRUCTIVE.test(line)) {
      if (!allowNext) problems.push(`${file}:${i + 1}: "${line.slice(0, 60)}" drops, deletes or truncates. Migrations only add; a destructive statement needs "-- allow-destructive: <reason>" on the line before it.`);
    }
    allowNext = false;
  });
  return problems;
}

function checkMigrations(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const problems = [];
  const seen = new Map();
  for (const f of files) {
    const m = NAME.exec(f);
    if (!m) { problems.push(`${f}: migration files are named NNNN_name.sql (digits, then lower-case letters, digits and underscores)`); continue; }
    if (seen.has(m[1])) problems.push(`${f}: number ${m[1]} is used twice (also ${seen.get(m[1])}); each migration needs its own number`);
    seen.set(m[1], f);
    problems.push(...checkFile(f, fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return { files: files.length, problems };
}

module.exports = { checkMigrations };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'db', 'migrations'));
  const { files, problems } = checkMigrations(dir);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`${files} migration file(s) only add: nothing is dropped, deleted or truncated.`);
}
