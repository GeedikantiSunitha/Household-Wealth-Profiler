// Who may do what (Phase 3): the permission table, several roles on one membership, and the compliance
// sign-off rules (the server fills the reviewer in; separation of duties by account), as pure functions.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../../packages/core/core.js');
const { ROLES, ACTIONS, SIGN_OFF_FIELDS, rolesOf, hasRole, can, authorize, stampSignOff, guardSave, guardCreate, withContributor } = require('../../../backend/src/services/access.js');

// A signed-in account. roles is optional (the primary role alone otherwise); userId is the account's id.
const session = (role, name = 'Casey Compliance', extra = {}) => ({ user: `${role}@example.com`, firmId: 'f', session: {}, role, name, userId: `${role}-id`, ...extra });
const dev = { user: 'demo', firmId: 'f' }; // HTTP Basic, development only: no session, no role
const code = (fn, c, status) => assert.throws(fn, e => e.code === c && (status === undefined || e.status === status), `expected ${c}`);

const state = (patch = {}) => { const s = H.normalise(H.blank()); for (const [k, v] of Object.entries(patch)) { const [sec, f] = k.split('.'); s[sec][f] = v; } return s; };
const changes = (before, after) => H.diff(before, after);

test('the table: three roles, and each action names the roles that may do it', () => {
  assert.deepEqual(ROLES, ['admin', 'adviser', 'compliance']);
  for (const [action, roles] of Object.entries(ACTIONS)) assert.ok(roles.length && roles.every(r => ROLES.includes(r)), action);
  const allow = (a) => ROLES.filter(r => can(session(r), a));
  assert.deepEqual(allow('households.read'), ['admin', 'adviser', 'compliance']);
  assert.deepEqual(allow('households.audit'), ['admin', 'adviser', 'compliance']);
  assert.deepEqual(allow('households.write'), ['admin', 'adviser']);
  assert.deepEqual(allow('firm.read'), ['admin', 'adviser', 'compliance']);
  assert.deepEqual(allow('firm.audit'), ['admin', 'compliance']);
  assert.deepEqual(allow('firm.write'), ['admin']);
  assert.deepEqual(allow('members.manage'), ['admin']);
  assert.deepEqual(allow('records.manage'), ['admin', 'compliance']);
});

test('a session acts as its roles in the firm: the primary role alone, or all of roles; none, or unknown ones, may do nothing', () => {
  assert.deepEqual(rolesOf(session('adviser')), ['adviser']);
  assert.deepEqual(rolesOf(session('admin', 'X', { roles: ['admin', 'compliance'] })), ['admin', 'compliance']);
  assert.deepEqual(rolesOf(session('admin', 'X', { roles: ['admin', 'admin', 'compliance', 'owner', 'ADVISER'] })), ['admin', 'compliance'], 'duplicates and unknown roles are dropped');
  for (const bad of [{ ...session('adviser'), role: '' }, { ...session('adviser'), role: null }, { ...session('adviser'), role: 'owner' }, { ...session('adviser'), role: 'ADMIN' }, { ...session('adviser'), roles: ['owner'] }]) {
    assert.deepEqual(rolesOf(bad), []);
    for (const a of Object.keys(ACTIONS)) assert.equal(can(bad, a), false, `${JSON.stringify(bad.roles || bad.role)} ${a}`);
  }
});

test('several roles on one membership: a person can do everything any of their roles can', () => {
  const both = session('admin', 'Dana Admin', { roles: ['admin', 'compliance'] });
  for (const a of ['households.read', 'households.audit', 'households.write', 'firm.read', 'firm.audit', 'firm.write', 'members.manage']) assert.equal(can(both, a), true, a);
  assert.equal(hasRole(both, 'compliance'), true); assert.equal(hasRole(both, 'adviser'), false);
  const adviserReviewer = session('adviser', 'Sam', { roles: ['adviser', 'compliance'] });
  assert.equal(can(adviserReviewer, 'households.write'), true); assert.equal(can(adviserReviewer, 'firm.write'), false); assert.equal(hasRole(adviserReviewer, 'compliance'), true);
  // the primary role alone, as before, when no roles list comes with the session
  assert.equal(hasRole(session('compliance'), 'compliance'), true); assert.equal(hasRole(session('adviser'), 'compliance'), false);
});

test('HTTP Basic (development only, no session) is unrestricted, as it always was; an unknown action is refused for everyone', () => {
  for (const a of Object.keys(ACTIONS)) assert.equal(can(dev, a), true, a);
  assert.equal(can(session('admin'), 'no.such.action'), false);
  assert.equal(can(dev, 'no.such.action'), false);
});

test('authorize refuses with 403 forbidden, naming the action, and passes silently when allowed', () => {
  assert.doesNotThrow(() => authorize(session('admin'), 'firm.write'));
  assert.doesNotThrow(() => authorize(session('compliance', 'C', { roles: ['compliance', 'admin'] }), 'firm.write'));
  code(() => authorize(session('adviser'), 'firm.write'), 'forbidden', 403);
  code(() => authorize(session('compliance'), 'members.manage'), 'forbidden', 403);
  try { authorize(session('adviser'), 'firm.write'); } catch (e) { assert.match(e.message, /administrator/i); }
});

test('sign-off fields: exactly the reviewer, review date, outcome and reviewer notes', () => {
  assert.deepEqual([...SIGN_OFF_FIELDS].sort(), ['compliance.outcome', 'compliance.reviewDate', 'compliance.reviewNotes', 'compliance.reviewer']);
  // every one is a real field of the compliance section, so a renamed field cannot silently stop being guarded
  const real = H.fieldsOf(H.SCHEMA.compliance).map(f => 'compliance.' + f.k);
  for (const f of SIGN_OFF_FIELDS) assert.ok(real.includes(f), f);
});

test('save: an adviser or administrator may change anything except the sign-off', () => {
  const before = state({ 'compliance.preparer': 'Sam Adviser' });
  for (const r of ['adviser', 'admin']) {
    const ok = state({ 'compliance.preparer': 'Sam Adviser', 'household.reference': 'R-1', 'compliance.riskNote': 'x', 'compliance.seniorApprover': 'Dana' });
    assert.doesNotThrow(() => guardSave(session(r), changes(before, ok), ok), r);
    for (const f of ['reviewer', 'reviewDate', 'outcome', 'reviewNotes']) {
      const value = { reviewer: 'Casey Compliance', reviewDate: '2026-10-01', outcome: 'approved', reviewNotes: 'ok' }[f];
      const bad = state({ 'compliance.preparer': 'Sam Adviser', ['compliance.' + f]: value });
      code(() => guardSave(session(r), changes(before, bad), bad), 'forbidden', 403);
    }
  }
});

test('save: a compliance reviewer may change the sign-off fields and nothing else', () => {
  const before = state({ 'compliance.preparer': 'Sam Adviser' });
  const signed = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Casey Compliance', 'compliance.reviewDate': '2026-10-01', 'compliance.outcome': 'approved', 'compliance.reviewNotes': 'Seen' });
  assert.doesNotThrow(() => guardSave(session('compliance'), changes(before, signed), signed));
  const other = state({ 'compliance.preparer': 'Sam Adviser', 'household.reference': 'R-1' });
  code(() => guardSave(session('compliance'), changes(before, other), other), 'forbidden', 403);
  const mixed = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Casey Compliance', 'household.reference': 'R-1' });
  code(() => guardSave(session('compliance'), changes(before, mixed), mixed), 'forbidden', 403);
  assert.doesNotThrow(() => guardSave(session('compliance'), [], before), 'nothing changed');
});

test('stampSignOff: the server puts the signed-in reviewer and the date on a sign-off; withdrawing clears both', () => {
  const s = state({ 'compliance.reviewer': 'Someone Else', 'compliance.reviewDate': '1999-01-01', 'compliance.outcome': 'approved' });
  stampSignOff(session('compliance', 'Casey Compliance'), s, '2026-10-09');
  assert.equal(s.compliance.reviewer, 'Casey Compliance'); assert.equal(s.compliance.reviewDate, '2026-10-09');
  // typed values never survive: a blank reviewer is filled in the same way
  const blank = state({ 'compliance.outcome': 'conditions', 'compliance.reviewNotes': 'Fix the ID' });
  stampSignOff(session('compliance', 'Casey Compliance'), blank, '2026-10-09');
  assert.deepEqual([blank.compliance.reviewer, blank.compliance.reviewDate], ['Casey Compliance', '2026-10-09']);
  // back to pending: the sign-off is withdrawn and so are its reviewer and date (the notes stay, as typed)
  const withdrawn = state({ 'compliance.reviewer': 'Casey Compliance', 'compliance.reviewDate': '2026-10-09', 'compliance.outcome': 'pending', 'compliance.reviewNotes': 'Re-check' });
  stampSignOff(session('compliance', 'Casey Compliance'), withdrawn, '2026-10-10');
  assert.deepEqual([withdrawn.compliance.reviewer, withdrawn.compliance.reviewDate, withdrawn.compliance.reviewNotes], ['', '', 'Re-check']);
  // an account with no name cannot sign anything off in its name
  code(() => stampSignOff(session('compliance', ''), state({ 'compliance.outcome': 'approved' }), '2026-10-09'), 'sign_off_identity', 403);
  // the same for someone with the role among several
  const dual = state({ 'compliance.outcome': 'approved' });
  stampSignOff(session('admin', 'Dana Admin', { roles: ['admin', 'compliance'] }), dual, '2026-10-09');
  assert.equal(dual.compliance.reviewer, 'Dana Admin');
  // not for anyone who is not a reviewer, and not for HTTP Basic: their typed values are left for the guard to refuse or allow
  for (const ctx of [session('adviser'), dev]) { const t = state({ 'compliance.reviewer': 'Typed', 'compliance.outcome': 'approved' }); stampSignOff(ctx, t, '2026-10-09'); assert.equal(t.compliance.reviewer, 'Typed'); }
});

test('save: the reviewer on a sign-off is the account that records it (the guard refuses anything else)', () => {
  const before = state({ 'compliance.preparer': 'Sam Adviser' });
  const asSomeone = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Dana Director', 'compliance.outcome': 'approved' });
  code(() => guardSave(session('compliance'), changes(before, asSomeone), asSomeone), 'sign_off_identity', 403);
  const own = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': '  casey compliance ', 'compliance.outcome': 'approved' });
  assert.doesNotThrow(() => guardSave(session('compliance'), changes(before, own), own), 'case and surrounding spaces do not matter');
  const nameless = { ...session('compliance'), name: '' };
  code(() => guardSave(nameless, changes(before, own), own), 'sign_off_identity', 403);
});

test('save: four-eyes by name still holds: the reviewer must differ from the named preparer', () => {
  const before = state({ 'compliance.preparer': 'Casey Compliance' });
  const same = state({ 'compliance.preparer': 'Casey Compliance', 'compliance.reviewer': 'Casey Compliance', 'compliance.outcome': 'approved' });
  code(() => guardSave(session('compliance'), changes(before, same), same), 'four_eyes', 400);
  const looseBefore = state({ 'compliance.preparer': ' casey compliance' });
  const sameLoose = state({ 'compliance.preparer': ' casey compliance', 'compliance.reviewer': 'Casey Compliance' });
  code(() => guardSave(session('compliance'), changes(looseBefore, sameLoose), sameLoose), 'four_eyes', 400);
});

test('separation of duties, by account: whoever has changed the file cannot sign it off, whatever roles they hold', () => {
  const before = state({ 'compliance.preparer': 'Sam Adviser' });
  const signed = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Dana Admin', 'compliance.outcome': 'approved' });
  const dana = session('admin', 'Dana Admin', { roles: ['admin', 'compliance'], userId: 'acct-dana' });
  // she has not touched this file: she may sign it off
  assert.doesNotThrow(() => guardSave(dana, changes(before, signed), signed, { contributors: ['acct-sam'] }));
  // she has: someone else must, even though her name is not on the preparer line
  code(() => guardSave(dana, changes(before, signed), signed, { contributors: ['acct-sam', 'acct-dana'] }), 'separation_of_duties', 403);
  // by account, not by name: the same name on another account is a different person
  const namesake = session('compliance', 'Dana Admin', { userId: 'acct-other-dana' });
  assert.doesNotThrow(() => guardSave(namesake, changes(before, signed), signed, { contributors: ['acct-dana'] }));
  // a file saved before contributors were kept has none recorded: nothing to compare yet (the name check above still applies)
  assert.doesNotThrow(() => guardSave(dana, changes(before, signed), signed, {}));
  // changing the file and signing it off in one save is refused to a person who holds both roles
  const mixed = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Dana Admin', 'compliance.outcome': 'approved', 'household.reference': 'R-9' });
  code(() => guardSave(dana, changes(before, mixed), mixed, { contributors: [] }), 'separation_of_duties', 403);
  // withdrawing a sign-off is not signing off: it is allowed to a reviewer who worked on the file, and is audited
  const was = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Casey', 'compliance.outcome': 'approved' });
  const cleared = state({ 'compliance.preparer': 'Sam Adviser' });
  assert.doesNotThrow(() => guardSave(dana, changes(was, cleared), cleared, { contributors: ['acct-dana'] }));
});

test('contributors: the accounts that changed a file, once each; none for HTTP Basic', () => {
  assert.deepEqual(withContributor({}, session('adviser', 'Sam', { userId: 'a1' })), ['a1']);
  assert.deepEqual(withContributor({ contributors: ['a1'] }, session('admin', 'Dana', { userId: 'a2' })), ['a1', 'a2']);
  assert.deepEqual(withContributor({ contributors: ['a1'] }, session('adviser', 'Sam', { userId: 'a1' })), ['a1'], 'once');
  assert.equal(withContributor({}, dev), undefined);
  assert.deepEqual(withContributor({ contributors: ['a1'] }, dev), ['a1'], 'Basic leaves the list as it is');
});

test('save: development (Basic) users are not restricted, so the existing tests and local trials behave as before', () => {
  const before = state();
  const all = state({ 'compliance.reviewer': 'Anyone', 'compliance.outcome': 'approved', 'household.reference': 'R-1' });
  assert.doesNotThrow(() => guardSave(dev, changes(before, all), all));
});

test('create: only roles that may write create households, and a new file carries no sign-off unless from a reviewer', () => {
  const plain = state({ 'household.reference': 'R-1' });
  assert.doesNotThrow(() => guardCreate(session('adviser'), plain));
  assert.doesNotThrow(() => guardCreate(session('admin'), plain));
  code(() => guardCreate(session('compliance'), plain), 'forbidden', 403);
  assert.doesNotThrow(() => guardCreate(session('compliance', 'C', { roles: ['compliance', 'adviser'] }), plain), 'a reviewer who is also an adviser may create');
  const withSignOff = state({ 'compliance.reviewer': 'Casey Compliance', 'compliance.outcome': 'approved' });
  code(() => guardCreate(session('adviser'), withSignOff), 'forbidden', 403);
  code(() => guardCreate(session('admin', 'D', { roles: ['admin', 'compliance'] }), withSignOff), 'forbidden', 403);
  assert.doesNotThrow(() => guardCreate(dev, withSignOff));
});

test('save: a compliance reviewer can clear a sign-off entirely (back to pending), whoever made it; that is an audited change', () => {
  const signed = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Dana Director', 'compliance.reviewDate': '2026-10-01', 'compliance.outcome': 'approved' });
  const cleared = state({ 'compliance.preparer': 'Sam Adviser' });
  assert.doesNotThrow(() => guardSave(session('compliance'), changes(signed, cleared), cleared));
  // but half-clearing it, leaving someone else's name, is still refused
  const half = state({ 'compliance.preparer': 'Sam Adviser', 'compliance.reviewer': 'Dana Director' });
  code(() => guardSave(session('compliance'), changes(signed, half), half), 'sign_off_identity', 403);
});
