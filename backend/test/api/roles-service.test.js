// Roles (Phase 3) through the real household and firm services on a file store: what each role can
// read and change, several roles on one membership, the review sign-off (filled in by the server,
// separation of duties by account, stale when the assessment changes), and that a refused call stores
// nothing. The permission table itself is in access.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../../../packages/core/core.js');
const { createHouseholdService } = require('../../../backend/src/services/households.js');
const { createFirmService } = require('../../../backend/src/services/firm.js');
const { createFileStore, DEFAULT_FIRM_ID } = require('../../../backend/src/repositories');
const { createSealer } = require('../../../backend/src/crypto/seal.js');

// A signed-in account: userId is its id (what separation of duties compares); roles is optional (several on one membership)
const as = (role, name, extra = {}) => ({ user: `${role}@example.com`, email: `${role}@example.com`, name, firmId: DEFAULT_FIRM_ID, session: {}, role, userId: `acct-${role}`, ...extra });
const ADMIN = as('admin', 'Dana Admin'), ADVISER = as('adviser', 'Sam Adviser'), COMPLIANCE = as('compliance', 'Casey Compliance');
const DEV = { user: 'demo', firmId: DEFAULT_FIRM_ID };
const ROLE_CTX = { admin: ADMIN, adviser: ADVISER, compliance: COMPLIANCE };
const forbidden = (p, code = 'forbidden', status = 403) => assert.rejects(p, e => e.status === status && e.code === code, `expected ${code}`);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-roles-'));
  const store = createFileStore(dir, createSealer(null));
  let t = 0, n = 0;
  const now = () => `2026-10-10T10:00:${String(t++).padStart(2, '0')}.000Z`;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  return { store, households: createHouseholdService({ store, HWP: H, now, newId, log: () => {} }), firm: createFirmService({ store, HWP: H, now }) };
}
const prepared = (ref = 'R-1') => { const s = H.sample(); s.isSample = false; s.household.reference = ref; s.compliance.preparer = 'Sam Adviser'; s.compliance.reviewer = ''; s.compliance.reviewDate = ''; s.compliance.outcome = 'pending'; s.compliance.reviewNotes = ''; return s; };
// open the household as ctx, change it, save it
async function edit(svc, ctx, id, fn) { const rec = await svc.get(ctx, id); const st = JSON.parse(JSON.stringify(rec.state)); fn(st); return svc.save(ctx, id, { version: rec.version, state: st }); }

test('households: every role reads; only an adviser or administrator creates', async () => {
  const { households } = setup();
  await forbidden(households.create(COMPLIANCE, prepared()));
  const { id } = await households.create(ADVISER, prepared());
  const { id: id2 } = await households.create(ADMIN, prepared('R-2'));
  for (const [r, ctx] of Object.entries(ROLE_CTX)) {
    assert.equal((await households.list(ctx)).length, 2, `${r} lists`);
    assert.equal((await households.get(ctx, id)).id, id, `${r} opens`);
    assert.ok(Array.isArray(await households.audit(ctx, id2)), `${r} reads the audit trail`);
  }
});

test('a session with no role, or an unknown one, reads and writes nothing', async () => {
  const { households, firm } = setup();
  const { id } = await households.create(ADVISER, prepared());
  for (const ctx of [{ ...ADVISER, role: '' }, { ...ADVISER, role: 'owner' }, { ...ADVISER, role: null }, { ...ADVISER, roles: ['owner'] }]) {
    await forbidden(households.list(ctx)); await forbidden(households.get(ctx, id)); await forbidden(households.audit(ctx, id));
    await forbidden(households.create(ctx, prepared('R-9'))); await forbidden(households.save(ctx, id, { version: 1, state: prepared() }));
    await forbidden(firm.get(ctx)); await forbidden(firm.audit(ctx)); await forbidden(firm.save(ctx, { version: 0, settings: H.firmBlank() }));
  }
});

test('the review sign-off: the reviewer and date are put on by the server from the signed-in account, never typed', async () => {
  const { households } = setup();
  const { id } = await households.create(ADVISER, prepared());

  // the adviser cannot sign off, and nothing is stored
  await forbidden(edit(households, ADVISER, id, st => { st.compliance.reviewer = 'Casey Compliance'; st.compliance.outcome = 'approved'; }));
  assert.equal((await households.get(ADVISER, id)).version, 1);
  // the reviewer cannot change the rest of the file
  await forbidden(edit(households, COMPLIANCE, id, st => { st.household.reference = 'R-CHANGED'; }));
  assert.equal((await households.get(COMPLIANCE, id)).version, 1);

  // the reviewer picks the outcome. Anything typed as the reviewer or the date is ignored: the account and the day are used
  const r = await edit(households, COMPLIANCE, id, st => { Object.assign(st.compliance, { reviewer: 'Dana Admin', reviewDate: '1999-01-01', outcome: 'approved', reviewNotes: 'Seen and agreed' }); });
  assert.equal(r.version, 2); assert.equal(r.changes, 4);
  assert.deepEqual(Object.keys(r.review).sort(), ['at', 'by', 'version']); assert.equal(r.review.by, 'Casey Compliance'); assert.equal(r.review.version, 2); assert.match(r.review.at, /^2026-10-10T10:00:\d\d\.000Z$/);
  const rec = await households.get(ADVISER, id);
  assert.deepEqual([rec.state.compliance.reviewer, rec.state.compliance.reviewDate, rec.state.compliance.outcome], ['Casey Compliance', '2026-10-10', 'approved']);
  assert.deepEqual(Object.keys(rec.review).sort(), ['at', 'by', 'version']); assert.equal(rec.review.by, 'Casey Compliance'); assert.equal(rec.review.version, 2);
  assert.equal(rec.reviewStale, false);
  const trail = (await households.audit(ADVISER, id)).filter(e => e.version === 2);
  assert.deepEqual(trail.map(e => e.field).sort(), ['compliance.outcome', 'compliance.reviewDate', 'compliance.reviewNotes', 'compliance.reviewer']);
  assert.ok(trail.every(e => e.user === 'compliance@example.com'));

  // the adviser carries on with the rest of the file and cannot undo the sign-off
  assert.deepEqual(await edit(households, ADVISER, id, st => { st.household.region = 'Scotland'; }), { version: 3, changes: 1, review: rec.review, reviewStale: false });
  await forbidden(edit(households, ADVISER, id, st => { st.compliance.outcome = 'pending'; }));
  assert.equal((await households.get(ADVISER, id)).state.compliance.outcome, 'approved');
});

test('who has changed a file is kept for the server\'s rules and never sent out', async () => {
  const { households, store } = setup();
  const { id } = await households.create(ADVISER, prepared());
  await edit(households, ADMIN, id, st => { st.household.region = 'Wales'; });
  const stored = await store.forFirm(DEFAULT_FIRM_ID).get(id);
  assert.deepEqual(stored.contributors, ['acct-adviser', 'acct-admin']);
  assert.equal((await households.get(ADVISER, id)).contributors, undefined);
  assert.deepEqual(Object.keys(await households.get(ADVISER, id)).sort(), ['createdAt', 'createdBy', 'id', 'state', 'updatedAt', 'updatedBy', 'version'], 'a file with no sign-off looks exactly as before');
  // a sign-off does not make the reviewer a contributor
  await edit(households, COMPLIANCE, id, st => { st.compliance.outcome = 'approved'; });
  assert.deepEqual((await store.forFirm(DEFAULT_FIRM_ID).get(id)).contributors, ['acct-adviser', 'acct-admin']);
});

test('separation of duties, by account: someone who holds admin and compliance cannot sign off a file they worked on', async () => {
  const { households } = setup();
  const DANA = as('admin', 'Dana Admin', { roles: ['admin', 'compliance'], userId: 'acct-dana' });
  const { id } = await households.create(ADVISER, prepared());
  // she signs off a file she has not touched: allowed
  const { id: other } = await households.create(ADVISER, prepared('R-2'));
  assert.equal((await edit(households, DANA, other, st => { st.compliance.outcome = 'approved'; })).version, 2);
  assert.equal((await households.get(DANA, other)).state.compliance.reviewer, 'Dana Admin');

  // she corrects a typo on the first file, as an administrator: now she is one of the people who prepared it
  await edit(households, DANA, id, st => { st.household.region = 'Wales'; });
  await forbidden(edit(households, DANA, id, st => { st.compliance.outcome = 'approved'; }), 'separation_of_duties');
  // not even in the same save as her changes
  await forbidden(edit(households, DANA, id, st => { st.household.region = 'Scotland'; st.compliance.outcome = 'approved'; }), 'separation_of_duties');
  assert.equal((await households.get(DANA, id)).state.compliance.outcome, 'pending');
  // another reviewer can, and a different account with the same name is a different person
  assert.equal((await edit(households, COMPLIANCE, id, st => { st.compliance.outcome = 'approved'; })).version, 3);
  const { id: third } = await households.create(DANA, prepared('R-3'));
  const NAMESAKE = as('compliance', 'Dana Admin', { userId: 'acct-someone-else' });
  assert.equal((await edit(households, NAMESAKE, third, st => { st.compliance.outcome = 'approved'; })).version, 2, 'by account, not by name');
  await forbidden(edit(households, DANA, third, st => { st.compliance.outcome = 'conditions'; st.compliance.reviewNotes = 'x'; }), 'separation_of_duties', 403);
});

test('withdrawing a sign-off: back to pending clears the reviewer, the date and the recorded review; a reviewer may do it even if they worked on the file', async () => {
  const { households } = setup();
  const DANA = as('admin', 'Dana Admin', { roles: ['admin', 'compliance'], userId: 'acct-dana' });
  const { id } = await households.create(DANA, prepared());
  await edit(households, COMPLIANCE, id, st => { st.compliance.outcome = 'approved'; });
  assert.ok((await households.get(DANA, id)).review);
  const r = await edit(households, DANA, id, st => { st.compliance.outcome = 'pending'; });
  assert.equal(r.review, null);
  const rec = await households.get(DANA, id);
  assert.deepEqual([rec.state.compliance.reviewer, rec.state.compliance.reviewDate, rec.state.compliance.outcome], ['', '', 'pending']);
  assert.equal(rec.review, undefined); assert.equal(rec.reviewStale, undefined);
});

test('a file with no contributors recorded (saved before they were kept, or by HTTP Basic) can be signed off by anyone with the role; the name check still applies', async () => {
  const { households } = setup();
  const DANA = as('admin', 'Dana Admin', { roles: ['admin', 'compliance'], userId: 'acct-dana' });
  const { id } = await households.create(DEV, prepared());
  assert.equal((await edit(households, DANA, id, st => { st.compliance.outcome = 'approved'; })).version, 2);
  const s = prepared('R-7'); s.compliance.preparer = 'Casey Compliance';
  const { id: id2 } = await households.create(DEV, s);
  await forbidden(edit(households, COMPLIANCE, id2, st => { st.compliance.outcome = 'approved'; }), 'four_eyes', 400);
});

test('a sign-off goes stale when the onboarding assessment changes afterwards, and not for edits that do not change it', async () => {
  const { households } = setup();
  const { id } = await households.create(ADVISER, prepared());
  await edit(households, COMPLIANCE, id, st => { st.compliance.outcome = 'approved'; });
  const signed = await households.get(ADVISER, id);
  assert.equal(signed.reviewStale, false);

  // not material: an address-type edit, a contact note
  let r = await edit(households, ADVISER, id, st => { st.household.region = 'Scotland'; });
  assert.equal(r.reviewStale, false);
  r = await edit(households, ADVISER, id, st => { st.contacts.push(H.defaults('contacts')); });
  assert.equal(r.reviewStale, false);
  assert.equal((await households.get(ADVISER, id)).reviewStale, false);

  // material: a client's identity details change what the review concluded on
  r = await edit(households, ADVISER, id, st => { st.members[0].niNumber = 'QQ123456C'; });
  assert.equal(r.reviewStale, true);
  const stale = await households.get(COMPLIANCE, id);
  assert.equal(stale.reviewStale, true);
  assert.equal(stale.state.compliance.outcome, 'approved', 'kept, not erased: it is evidence of what was reviewed');
  assert.equal(stale.review.version, signed.review.version, 'it still says which version was reviewed');
  assert.ok(stale.version > stale.review.version);

  // switching a risk factor is material too, and a later edit that puts it back makes the sign-off current again
  await edit(households, ADVISER, id, st => { st.members[0].niNumber = signed.state.members[0].niNumber; });
  assert.equal((await households.get(ADVISER, id)).reviewStale, false, 'the assessment is as it was reviewed');

  // a reviewer records the review again on the changed file: current, on the new version
  await edit(households, ADVISER, id, st => { st.compliance.highRiskCountry = true; });
  assert.equal((await households.get(ADVISER, id)).reviewStale, true);
  const again = await edit(households, COMPLIANCE, id, st => { st.compliance.reviewNotes = 'Re-reviewed after the high-risk country link'; });
  assert.equal(again.reviewStale, false);
  const now = await households.get(COMPLIANCE, id);
  assert.equal(now.reviewStale, false); assert.equal(now.review.version, again.version);
});

test('four-eyes: a reviewer who is also the named preparer cannot sign the file off (400 four_eyes)', async () => {
  const { households } = setup();
  const s = prepared(); s.compliance.preparer = 'Casey Compliance';
  const { id } = await households.create(ADVISER, s);
  await forbidden(edit(households, COMPLIANCE, id, st => { st.compliance.outcome = 'approved'; }), 'four_eyes', 400);
});

test('a new file cannot arrive already signed off by an adviser or administrator', async () => {
  const { households } = setup();
  const s = prepared(); Object.assign(s.compliance, { reviewer: 'Casey Compliance', outcome: 'approved' });
  await forbidden(households.create(ADVISER, s)); await forbidden(households.create(ADMIN, s));
  assert.equal((await households.list(DEV)).length, 0);
  assert.ok((await households.create(DEV, s)).id, 'development (Basic) is unrestricted, as before');
});

test('firm settings: every role reads, only an administrator saves (alone or among several roles), the audit trail is for administrators and compliance', async () => {
  const { firm } = setup();
  for (const ctx of Object.values(ROLE_CTX)) assert.equal((await firm.get(ctx)).version, 0);
  const s = H.firmBlank(); s.firm.name = 'Alder Wealth';
  await forbidden(firm.save(ADVISER, { version: 0, settings: s }));
  await forbidden(firm.save(COMPLIANCE, { version: 0, settings: s }));
  assert.equal((await firm.get(ADMIN)).version, 0, 'nothing was stored');
  assert.deepEqual(await firm.save(as('compliance', 'C', { roles: ['compliance', 'admin'] }), { version: 0, settings: s }), { version: 1, changes: 1 });
  assert.equal((await firm.get(ADVISER)).settings.firm.name, 'Alder Wealth');
  await forbidden(firm.audit(ADVISER));
  for (const ctx of [ADMIN, COMPLIANCE]) assert.equal((await firm.audit(ctx))[0].field, 'firm.name');
});

test('development (HTTP Basic) is unrestricted, so the existing behaviour is unchanged', async () => {
  const { households, firm } = setup();
  const { id } = await households.create(DEV, prepared());
  const r = await edit(households, DEV, id, st => { Object.assign(st.compliance, { reviewer: 'Anyone', outcome: 'approved' }); });
  assert.deepEqual(r, { version: 2, changes: 2 }, 'no review is recorded and nothing extra is in the reply');
  assert.equal((await households.get(DEV, id)).state.compliance.reviewer, 'Anyone', 'typed values are kept as they were');
  const s = H.firmBlank(); s.firm.name = 'X';
  assert.equal((await firm.save(DEV, { version: 0, settings: s })).version, 1);
  assert.equal((await firm.audit(DEV)).length, 1);
});
