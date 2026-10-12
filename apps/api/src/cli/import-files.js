/* node server.js import-files [DIR]: copies households from a file store (DATA_DIR by default) into
   PostgreSQL with every version and the whole audit trail, keeping ids, times and authors.
   The firm settings, with their versions and audit trail, are copied too unless the database already
   has firm settings. Households already in the database are skipped, so it can be run again safely. */
'use strict';
const path = require('path');
const { createFileStore } = require('../repositories');

async function importFiles({ dir, databaseUrl, store, sealer }) {
  if (!databaseUrl) { console.error('Set DATABASE_URL to the database to copy into.'); return 1; }
  const from = createFileStore(path.resolve(dir), sealer);
  await store.init();
  let copied = 0, skipped = 0;
  for (const id of await from.ids()) {
    const versions = await from.versions(id);
    if (!versions.length) { const cur = await from.get(id); if (cur) versions.push(cur); }
    if (!versions.length) continue;
    if (await store.importHousehold(versions, (await from.audit(id)).reverse())) copied++; else skipped++;
  }
  console.log(`Copied ${copied} household(s) from ${path.resolve(dir)} (${skipped} already in the database).`);
  const firmVersions = await from.firm.versions();
  if (!firmVersions.length) { const cur = await from.firm.get(); if (cur) firmVersions.push(cur); }
  if (firmVersions.length) console.log(await store.firm.importAll(firmVersions, (await from.firm.audit()).reverse())
    ? `Copied the firm settings (${firmVersions.length} version(s)).` : 'Firm settings not copied: the database already has firm settings.');
  await store.end();
  return 0;
}

module.exports = { importFiles };
