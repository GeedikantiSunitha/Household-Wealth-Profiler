/* node server.js backup: one encrypted, checked backup of the whole database.
     1. Connects as BACKUP_DATABASE_URL, a role that reads every row (superuser or BYPASSRLS; refused
        otherwise, since row security would silently leave rows out), and opens a read-only
        repeatable-read transaction whose snapshot it exports.
     2. In that snapshot: the row count of every table, the migrations applied, the triggers and
        row-security policies, the server version. pg_dump then dumps exactly that snapshot, so the
        counts in the manifest are the counts in the dump.
     3. pg_dump's output is encrypted as it streams (crypto/backup-cipher.js, BACKUP_KEY): no
        unencrypted dump is ever written to disk. The file is written under a temporary name and
        renamed only when pg_dump has finished cleanly.
     4. A manifest beside it (counts, migrations, sizes, SHA-256 of the encrypted file, the key's
        fingerprint), signed with a key derived from BACKUP_KEY.
     5. Backups in BACKUP_DIR older than BACKUP_RETENTION_DAYS are removed, never the newest.
   Files: hwp-<database>-<UTC time>.backup and .backup.manifest.json. Exit 0 done, 1 failed.
   Keep BACKUP_KEY and DATA_KEY apart from the backups and from each other; copy BACKUP_DIR off the
   hosting platform (the restore drill, restore.js, proves a backup can be brought back). */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { encryptStream, keyId, signManifest } = require('../crypto/backup-cipher.js');

const NAME = /^hwp-(.+)-(\d{8}T\d{6}Z)\.backup$/;
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const fromStamp = s => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

// pg_dump / pg_restore: from PG_BIN, else the PATH
const tool = (pgBin, name) => pgBin ? path.join(pgBin, process.platform === 'win32' ? name + '.exe' : name) : name;
function toolMajor(pgBin, name) {
  const out = execFileSync(tool(pgBin, name), ['--version']).toString();
  const m = /(\d+)(?:\.\d+)?/.exec(out.replace(/^[^)]*\)/, ''));
  if (!m) throw new Error(`Cannot tell the version of ${name}: ${out.trim()}`);
  return +m[1];
}
// libpq settings for a child process: the password goes in the environment, never on the command line
function libpqEnv(url, database) {
  const u = new URL(url);
  const env = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGDATABASE: database || decodeURIComponent(u.pathname.slice(1)) };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password); else delete env.PGPASSWORD;
  const ssl = u.searchParams.get('sslmode'); if (ssl) env.PGSSLMODE = ssl;
  return env;
}
const withDatabase = (url, database) => { const u = new URL(url); u.pathname = '/' + database; return u.toString(); };

// What the manifest records about a database, read through client c (inside the backup's snapshot)
async function describe(c) {
  const tables = (await c.query(`select table_schema s, table_name t from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`)).rows;
  const counts = {};
  for (const { s, t } of tables) counts[`${s}.${t}`] = (await c.query(`select count(*)::bigint n from ${c.escapeIdentifier(s)}.${c.escapeIdentifier(t)}`)).rows[0].n.toString();
  const migrations = [];
  for (const { s } of tables.filter(x => x.t === 'schema_migrations')) for (const r of (await c.query(`select name from ${c.escapeIdentifier(s)}.schema_migrations order by name`)).rows) migrations.push(r.name);
  const triggers = (await c.query(`select n.nspname || '.' || c.relname || '.' || t.tgname x from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname not in ('pg_catalog', 'information_schema') order by 1`)).rows.map(r => r.x);
  const policies = (await c.query(`select schemaname || '.' || tablename || '.' || policyname x from pg_policies order by 1`)).rows.map(r => r.x);
  return { counts, migrations, triggers, policies };
}

async function canReadEverything(c) {
  return (await c.query('select rolsuper or rolbypassrls ok from pg_roles where rolname = current_user')).rows[0].ok;
}

async function backup({ backupUrl, dir, backupKey, retentionDays = 35, pgBin = '', now = () => new Date(), log = console.log }) {
  if (!backupUrl) { console.error('Set BACKUP_DATABASE_URL: a role that can read every row (superuser or BYPASSRLS), not hwp_app or hwp_owner.'); return 1; }
  if (!dir) { console.error('Set BACKUP_DIR: the folder the encrypted backups are written to.'); return 1; }
  if (!backupKey) { console.error('Set BACKUP_KEY (node server.js gen-key): backups are always encrypted, with a key of their own.'); return 1; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: backupUrl });
  await c.connect();
  const database = decodeURIComponent(new URL(backupUrl).pathname.slice(1));
  const started = now();
  const base = `hwp-${database.replace(/[^\w.-]+/g, '_')}-${stamp(started)}.backup`;
  const file = path.join(dir, base), partial = file + '.partial';
  try {
    if (!(await canReadEverything(c))) { console.error('BACKUP_DATABASE_URL must be a role that reads every row (superuser or BYPASSRLS): row-level security would leave rows out of the backup. Nothing was written.'); return 1; }
    const serverMajor = Math.floor(+(await c.query('show server_version_num')).rows[0].server_version_num / 10000);
    const dumpMajor = toolMajor(pgBin, 'pg_dump');
    if (dumpMajor < serverMajor) { console.error(`pg_dump ${dumpMajor} cannot back up a PostgreSQL ${serverMajor} server. Set PG_BIN to the folder of pg_dump ${serverMajor} or later.`); return 1; }
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

    await c.query('begin isolation level repeatable read, read only');
    const snapshot = (await c.query('select pg_export_snapshot() s')).rows[0].s;
    const facts = await describe(c);
    const serverVersion = (await c.query('show server_version')).rows[0].server_version;

    const dump = spawn(tool(pgBin, 'pg_dump'), ['--format=custom', '--no-password', `--snapshot=${snapshot}`], { env: libpqEnv(backupUrl), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    dump.stderr.on('data', d => { stderr += d; });
    const exited = new Promise(ok => dump.on('close', code => ok(code)));
    const hash = crypto.createHash('sha256');
    let plainBytes = 0, bytes = 0;
    const countPlain = new Transform({ transform(ch, e, d) { plainBytes += ch.length; d(null, ch); } });
    const tap = new Transform({ transform(ch, e, d) { hash.update(ch); bytes += ch.length; d(null, ch); } });
    try {
      await pipeline(dump.stdout, countPlain, encryptStream(backupKey), tap, fs.createWriteStream(partial, { mode: 0o600 }));
    } catch (e) { dump.kill(); throw e; }
    const code = await exited;
    await c.query('commit');
    if (code !== 0) throw new Error(`pg_dump failed (exit ${code}): ${stderr.trim().split('\n').pop()}`);
    await fsp.rename(partial, file);

    const manifest = signManifest(backupKey, {
      format: 1, kind: 'hwp-backup', file: base, database, createdAt: started.toISOString(), finishedAt: now().toISOString(),
      serverVersion, pgDumpMajor: dumpMajor, cipher: 'HWPBK001 aes-256-gcm stream', keyId: keyId(backupKey),
      bytes, plainBytes, sha256: hash.digest('hex'), ...facts,
    });
    await fsp.writeFile(file + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const tables = Object.keys(facts.counts).length, rows = Object.values(facts.counts).reduce((a, n) => a + +n, 0);
    log(`Backup written: ${file} (${bytes} bytes encrypted, ${tables} tables, ${rows} rows, ${facts.migrations.length} migrations).`);
    const removed = await prune(dir, database, retentionDays, now());
    if (removed.length) log(`Removed ${removed.length} backup(s) older than ${retentionDays} days: ${removed.join(', ')}`);
    return 0;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    await fsp.rm(partial, { force: true }).catch(() => {});
    console.error('Backup failed; nothing was kept: ' + e.message);
    return 1;
  } finally { await c.end().catch(() => {}); }
}

// The backups of one database in dir, newest first
async function listBackups(dir, database) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.map(n => [n, NAME.exec(n)]).filter(([, m]) => m && (!database || m[1] === database.replace(/[^\w.-]+/g, '_')))
    .map(([n, m]) => ({ name: n, database: m[1], at: fromStamp(m[2]) })).sort((a, b) => b.at - a.at);
}
async function prune(dir, database, days, at) {
  const all = await listBackups(dir, database);
  const old = all.slice(1).filter(b => at - b.at > days * 86400e3);
  for (const b of old) { await fsp.rm(path.join(dir, b.name), { force: true }); await fsp.rm(path.join(dir, b.name + '.manifest.json'), { force: true }); }
  return old.map(b => b.name);
}

module.exports = { backup, listBackups, prune, describe, canReadEverything, libpqEnv, withDatabase, tool, toolMajor, stamp };
