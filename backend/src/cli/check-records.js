/* node server.js check-records [firmId]: reports every stored household and firm settings record
   that the field rules (services/validate.js) would refuse, and every record that cannot be read,
   without changing anything. Run it on a database before a release that enforces the rules, so
   records saved under older rules can be corrected first. Without a firm id every firm is checked:
   on PostgreSQL that needs DATABASE_OWNER_URL (the app role sees one firm at a time); on files the
   firm folders are listed. Output names ids, field paths and rules, never a stored value.
   Exit 0 when clean, 2 when any problem or unreadable record was found, 1 when it could not run. */
'use strict';
const fs = require('fs');
const path = require('path');
const { validateHousehold, validateFirm } = require('../services/validate.js');
const { DEFAULT_FIRM_ID } = require('../repositories');

async function firmIdsOf({ databaseUrl, ownerUrl, dataDir }) {
  if (databaseUrl) {
    if (!ownerUrl) throw new Error('Set DATABASE_OWNER_URL to check every firm, or give one firm id.');
    const pg = require('pg');
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    try { return (await c.query('select id from firms order by id')).rows.map(r => r.id); } finally { await c.end(); }
  }
  const ids = [DEFAULT_FIRM_ID];
  try { ids.push(...fs.readdirSync(path.join(dataDir, 'firms')).filter(d => /^[0-9a-f-]{36}$/.test(d)).sort()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return ids;
}

async function checkRecords({ store, H, dataDir, databaseUrl, ownerUrl, firmId, out = console.log }) {
  const firmIds = firmId ? [firmId] : await firmIdsOf({ databaseUrl, ownerUrl, dataDir });
  let records = 0, problems = 0, flagged = 0;
  for (const id of firmIds) {
    const scoped = store.forFirm(id);
    const unreadable = [];
    const list = await scoped.list({ onUnreadable: rid => unreadable.push(rid) });
    const lines = [];
    let withProblems = 0;
    for (const rec of list) {
      const s = H.normalise(rec.state); delete s.audit;
      const errs = validateHousehold(H, s);
      if (errs.length) withProblems++;
      for (const e of errs) lines.push(`  ${rec.id}: ${e.field} ${e.message}`);
      problems += errs.length;
    }
    for (const rid of unreadable) lines.push(`  ${rid}: unreadable (a wrong key or a damaged record)`);
    const firmRec = await scoped.firm.get();
    let firmNote = 'none saved';
    if (firmRec) {
      const errs = validateFirm(H, H.firmNormalise(firmRec.settings));
      firmNote = errs.length ? `${errs.length} problem(s)` : 'ok';
      for (const e of errs) lines.push(`  firm settings: ${e.field} ${e.message}`);
      problems += errs.length;
      if (errs.length) flagged++;
      records++;
    }
    records += list.length + unreadable.length;
    flagged += withProblems + unreadable.length;
    problems += unreadable.length;
    out(`Firm ${id}: ${list.length + unreadable.length} household(s) checked, ${withProblems} with problems, ${unreadable.length} unreadable; firm settings: ${firmNote}`);
    for (const l of lines) out(l);
  }
  if (problems) { out(`${problems} problem(s) in ${flagged} record(s) across ${firmIds.length} firm(s). Nothing was changed.`); return 2; }
  out(`No problems found: ${records} record(s) across ${firmIds.length} firm(s). Nothing was changed.`);
  return 0;
}

module.exports = { checkRecords };
