/* node server.js rotate-key: replaces the master key (DATA_KEY). Records are sealed with each
   firm's own key, and only the firms' keys are wrapped by the master, so rotating the master means
   re-wrapping those keys: unwrap each with the current DATA_KEY, wrap it with NEW_DATA_KEY, in one
   transaction as the owner (DATABASE_OWNER_URL). No record is rewritten. Afterwards set DATA_KEY
   to the new key on every server and restart them; until then running servers keep working from
   the keys they already unwrapped.
   Refuses, changing nothing, while any record is still sealed with the master key itself
   (enc:v1, from before tenancy): those would become unreadable. Re-sealing them is the key
   rotation work of Phase 4; until then such a database keeps its DATA_KEY. */
'use strict';
const { wrapKey, unwrapKey } = require('../crypto/seal.js');

const V1 = [['households', 'doc'], ['household_versions', 'doc'], ['audit_log', 'entry'], ['firm_records', 'doc'], ['firm_record_versions', 'doc'], ['firm_audit', 'entry']];

async function rotateKey({ ownerUrl, key, newKey }) {
  if (!ownerUrl) { console.error('Set DATABASE_OWNER_URL (or DATABASE_URL) to the database whose firm keys to re-wrap.'); return 1; }
  if (!key) { console.error('DATA_KEY (the current key) is required.'); return 1; }
  if (!newKey) { console.error('Set NEW_DATA_KEY to the new key (node server.js gen-key).'); return 1; }
  const pg = require('pg');
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('begin');
    let v1 = 0;
    for (const [t, col] of V1) v1 += (await c.query(`select count(*)::int n from ${t} where ${col} like 'enc:v1:%'`)).rows[0].n;
    if (v1) { await c.query('rollback'); console.error(`${v1} record(s) still sealed with DATA_KEY itself (enc:v1). They must be re-sealed with their firm's key before the master key can change; nothing was changed.`); return 1; }
    const firms = (await c.query('select id, wrapped_key from firms where wrapped_key is not null order by id for update')).rows;
    for (const f of firms) await c.query('update firms set wrapped_key = $2 where id = $1', [f.id, wrapKey(newKey, unwrapKey(key, f.wrapped_key))]);
    await c.query('commit');
    console.log(`${firms.length} firm key(s) re-wrapped. Now set DATA_KEY to the new key on every server and restart them; keep the old key until every server has restarted.`);
    return 0;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { await c.end(); }
}

module.exports = { rotateKey };
