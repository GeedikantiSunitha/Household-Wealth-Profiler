/* node server.js restore-drill [FILE] [--keep]: proves a backup can be brought back, and how long it
   takes. The newest backup in BACKUP_DIR unless FILE names one.
     1. The manifest's signature (BACKUP_KEY) and the file's SHA-256 are checked before anything else.
     2. A new scratch database, <database>_restore_drill_<UTC time>, is made on the server of
        BACKUP_DATABASE_URL (the role needs CREATEDB), with the app's roles if the cluster lacks them.
     3. The backup is decrypted as it streams into pg_restore (--exit-on-error): no unencrypted dump
        is written to disk.
     4. Checks, each passed or failed in the report:
          counts       every table holds the row count the manifest recorded
          migrations   the same migrations, in the same order; any this code has that the backup
                       lacks are listed (they would run at the next deploy)
          triggers     every retention trigger and row-security policy is back
          records      every record, version, audit entry and firm-settings row opens with its
                       firm's key (unwrapped with DATA_KEY), and every authenticator secret opens
          isolation    as hwp_app with no firm set, no client row is visible; with a firm set, only
                       that firm's
     5. The scratch database is dropped, unless --keep (then it is the restored copy: point a server's
        DATABASE_URL at it after checking, see README). A report is written beside the backup as
        <file>.drill-<UTC time>.json, and the summary printed.
   Exit 0 every check passed, 2 a check failed, 1 the drill could not run. Never touches any database
   it did not make in this run. */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { decryptStream, verifyManifest, keyId } = require('../crypto/backup-cipher.js');
const { createFirmSealer, createSealer, unwrapKey } = require('../crypto/seal.js');
const { listBackups, describe, canReadEverything, libpqEnv, withDatabase, tool, toolMajor, stamp } = require('./backup.js');

const SEALED = [['households', 'doc', 'id'], ['household_versions', 'doc', 'household_id, version'], ['audit_log', 'entry', 'id'],
  ['firm_records', 'doc', 'firm_id'], ['firm_record_versions', 'doc', 'firm_id, version'], ['firm_audit', 'entry', 'id']];
const SCRATCH = /_restore_drill_\d{8}t\d{6}z$/;
const BATCH = 1000;

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), new Transform({ transform(c, e, d) { h.update(c); d(); } }));
  return h.digest('hex');
}

// Every sealed row opens: each firm's key unwrapped with DATA_KEY; v1 rows with DATA_KEY itself
async function checkRecords(c, schema, dataKey) {
  const q = (sql, p) => c.query(sql.replace(/\{s\}/g, c.escapeIdentifier(schema)), p);
  const sealers = new Map(), problems = [];
  for (const f of (await q('select id, wrapped_key from {s}.firms')).rows) {
    try { sealers.set(f.id, createFirmSealer({ master: dataKey, firmKey: f.wrapped_key && dataKey ? unwrapKey(dataKey, f.wrapped_key) : null })); }
    catch (e) { problems.push(`firm ${f.id}: its key does not unwrap with DATA_KEY`); }
  }
  let opened = 0;
  for (const [t, col, order] of SEALED) {
    for (let off = 0; ; off += BATCH) {
      const rows = (await q(`select firm_id, ${col} as text from {s}.${t} order by ${order} limit ${BATCH} offset ${off}`)).rows;
      for (const r of rows) {
        const s = sealers.get(r.firm_id);
        try { if (!s) throw new Error('no key'); JSON.parse(s.open(r.text)); opened++; } catch (e) { if (problems.length < 20) problems.push(`${t}: a row of firm ${r.firm_id} does not open (${e.message})`); else if (problems.length === 20) problems.push('...'); }
      }
      if (rows.length < BATCH) break;
    }
  }
  const master = createSealer(dataKey);
  const hasTotp = (await q(`select 1 from information_schema.columns where table_schema = $1 and table_name = 'users' and column_name = 'totp_secret'`, [schema])).rows.length > 0;
  if (hasTotp) for (const u of (await q('select id, totp_secret, totp_pending from {s}.users where totp_secret is not null or totp_pending is not null')).rows) {
    for (const v of [u.totp_secret, u.totp_pending]) if (v != null) { try { master.open(v); opened++; } catch (e) { problems.push(`users: the authenticator secret of account ${u.id} does not open`); } }
  }
  return { opened, problems };
}

// As the app role: nothing without a firm; one firm's rows with it
async function checkIsolation(c, schema) {
  const s = c.escapeIdentifier(schema);
  const member = (await c.query("select rolsuper or pg_has_role(current_user, 'hwp_app', 'member') ok from pg_roles where rolname = current_user")).rows[0].ok;
  if (!member) return { skipped: 'the drill role cannot act as hwp_app (needs to be a superuser or a member of hwp_app)' };
  const firm = (await c.query(`select firm_id, count(*)::int n from ${s}.households group by 1 order by 2 desc limit 1`)).rows[0];
  await c.query('begin');
  try {
    await c.query(`set local search_path = ${s}`);
    await c.query('set local role hwp_app');
    const none = (await c.query('select count(*)::int n from households')).rows[0].n;
    let own = null;
    if (firm) { await c.query("select set_config('app.firm_id', $1, true)", [firm.firm_id]); own = (await c.query('select count(*)::int n from households')).rows[0].n; }
    return { withoutFirm: none, firm: firm ? firm.firm_id : null, firmRows: own, expected: firm ? firm.n : null, ok: none === 0 && (!firm || own === firm.n) };
  } finally { await c.query('rollback'); }
}

async function restoreDrill({ backupUrl, dir, file, backupKey, dataKey, pgBin = '', keep = false, migrationsDir, now = () => new Date(), log = console.log }) {
  if (!backupUrl) { console.error('Set BACKUP_DATABASE_URL: a role that can create a database and read every row.'); return 1; }
  if (!backupKey) { console.error('Set BACKUP_KEY: the key the backups were made with.'); return 1; }
  if (!dataKey) { console.error('Set DATA_KEY: the drill proves the restored records still open.'); return 1; }
  if (!file) {
    const newest = (await listBackups(dir))[0];
    if (!newest) { console.error(`No backup in ${dir || '(BACKUP_DIR is not set)'}.`); return 1; }
    file = path.join(dir, newest.name);
  }
  const t0 = now();
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(file + '.manifest.json', 'utf8')); } catch (e) { console.error(`Cannot read the manifest ${file}.manifest.json: ${e.message}`); return 1; }
  if (!verifyManifest(backupKey, manifest)) { console.error(`The manifest of ${path.basename(file)} fails its signature check: altered, or made with another BACKUP_KEY (this key is ${keyId(backupKey)}, the manifest names ${manifest.keyId}). Nothing was restored.`); return 1; }
  const sum = await sha256File(file);
  if (sum !== manifest.sha256) { console.error(`${path.basename(file)} does not match its manifest (SHA-256 differs): damaged or replaced. Nothing was restored.`); return 1; }
  const restoreMajor = toolMajor(pgBin, 'pg_restore');
  if (restoreMajor < manifest.pgDumpMajor) { console.error(`pg_restore ${restoreMajor} cannot read a dump from pg_dump ${manifest.pgDumpMajor}. Set PG_BIN.`); return 1; }

  const { Client } = require('pg');
  const admin = new Client({ connectionString: backupUrl });
  await admin.connect();
  const scratch = `${manifest.database}`.slice(0, 30).replace(/[^\w]+/g, '_').toLowerCase() + '_restore_drill_' + stamp(now()).toLowerCase();
  if (!SCRATCH.test(scratch)) { await admin.end(); throw new Error('scratch name check failed: ' + scratch); }
  const checks = [], report = { kind: 'hwp-restore-drill', backup: path.basename(file), manifestCreatedAt: manifest.createdAt, database: scratch, startedAt: t0.toISOString(), checks };
  const check = (name, ok, detail) => { checks.push({ name, ok, ...detail }); };
  let created = false, code = 1;
  try {
    if (!(await canReadEverything(admin))) { console.error('BACKUP_DATABASE_URL must be a role that reads every row (superuser or BYPASSRLS) to check the restored copy.'); return 1; }
    for (const r of ['hwp_owner', 'hwp_app']) {
      if (!(await admin.query('select 1 from pg_roles where rolname = $1', [r])).rows.length) {
        try { await admin.query(`create role ${r} nologin nosuperuser nobypassrls`); log(`Created role ${r} (absent on this cluster; it has no login).`); }
        catch (e) { log(`Role ${r} is absent and could not be created (${e.message}); objects it owned stay with the restoring role.`); }
      }
    }
    await admin.query(`create database ${admin.escapeIdentifier(scratch)} template template0`);
    created = true;

    const tRestore = Date.now();
    const restore = spawn(tool(pgBin, 'pg_restore'), ['--exit-on-error', '--no-password', `--dbname=${scratch}`], { env: libpqEnv(backupUrl, scratch), stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    restore.stderr.on('data', d => { stderr += d; });
    const exited = new Promise(ok => restore.on('close', c => ok(c)));
    let piped = null;
    try { await pipeline(fs.createReadStream(file), decryptStream(backupKey), restore.stdin); } catch (e) { piped = e; restore.kill(); }
    const rc = await exited;
    if (piped) throw new Error('decryption failed: ' + piped.message);
    if (rc !== 0) throw new Error(`pg_restore failed (exit ${rc}): ${stderr.trim().split('\n').pop()}`);
    report.restoreSeconds = Math.round((Date.now() - tRestore) / 100) / 10;

    const c = new Client({ connectionString: withDatabase(backupUrl, scratch) });
    await c.connect();
    try {
      const facts = await describe(c);
      const diff = Object.keys({ ...manifest.counts, ...facts.counts }).filter(k => manifest.counts[k] !== facts.counts[k]).map(k => `${k}: ${manifest.counts[k] || 'absent'} in the backup, ${facts.counts[k] || 'absent'} restored`);
      check('counts', diff.length === 0, { tables: Object.keys(facts.counts).length, rows: Object.values(facts.counts).reduce((a, n) => a + +n, 0), differences: diff });
      const onDisk = migrationsDir ? fs.readdirSync(migrationsDir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort() : [];
      check('migrations', JSON.stringify(facts.migrations) === JSON.stringify(manifest.migrations), { applied: facts.migrations.length, notYetApplied: onDisk.filter(f => !facts.migrations.includes(f)) });
      const missingT = manifest.triggers.filter(t => !facts.triggers.includes(t)), missingP = manifest.policies.filter(p => !facts.policies.includes(p));
      check('triggers', !missingT.length && !missingP.length, { triggers: facts.triggers.length, policies: facts.policies.length, missingTriggers: missingT, missingPolicies: missingP });
      const schema = (Object.keys(facts.counts).find(k => k.endsWith('.households')) || 'public.households').split('.')[0];
      const rec = await checkRecords(c, schema, dataKey);
      check('records', rec.problems.length === 0, { opened: rec.opened, problems: rec.problems });
      const iso = await checkIsolation(c, schema);
      check('isolation', iso.skipped ? false : iso.ok, iso);
    } finally { await c.end(); }
    code = checks.every(x => x.ok) ? 0 : 2;
  } catch (e) {
    check('restore', false, { error: e.message });
    code = 2;
  } finally {
    if (created && !keep) { await admin.query(`drop database if exists ${admin.escapeIdentifier(scratch)}`).catch(e => log(`Could not drop ${scratch}: ${e.message}`)); report.dropped = true; }
    await admin.end().catch(() => {});
  }
  report.finishedAt = now().toISOString();
  report.totalSeconds = Math.round((new Date(report.finishedAt) - t0) / 100) / 10;
  report.passed = code === 0;
  const out = `${file}.drill-${stamp(now())}.json`;
  await fsp.writeFile(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const x of checks) log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.error ? ': ' + x.error : ''}${x.differences && x.differences.length ? ': ' + x.differences.join('; ') : ''}${x.problems && x.problems.length ? ': ' + x.problems.join('; ') : ''}${x.skipped ? ': ' + x.skipped : ''}`);
  log(`${report.passed ? 'Restore drill passed' : 'Restore drill FAILED'}: ${path.basename(file)} restored in ${report.restoreSeconds ?? '-'} s (${report.totalSeconds} s in all)${keep && created ? `; kept as database ${scratch}` : ''}. Report: ${out}`);
  return code;
}

module.exports = { restoreDrill, checkRecords, checkIsolation };
