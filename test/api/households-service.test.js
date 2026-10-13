// apps/api/src/services/households.js: the household flow without HTTP. A fixed clock and ids
// make every result exact; expected summaries are worked out with packages/core directly.
// Every call carries the context { user, firmId }: the store is scoped to that firm.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../../packages/core/core.js');
const { createHouseholdService, summarise, AUDIT_LIMIT } = require('../../apps/api/src/services/households.js');
const { createFileStore, DEFAULT_FIRM_ID } = require('../../apps/api/src/repositories');
const { createSealer } = require('../../apps/api/src/crypto/seal.js');

const SAM = { user: 'sam', firmId: DEFAULT_FIRM_ID }, CHRIS = { user: 'chris', firmId: DEFAULT_FIRM_ID };
const OTHER_FIRM = { user: 'sam', firmId: '0f1e0000-0000-4000-8000-000000000002' };

function setup({ production = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-svc-'));
  const store = createFileStore(dir, createSealer(null));
  let t = 0, n = 0;
  const now = () => `2026-10-10T10:00:${String(t++).padStart(2, '0')}.000Z`;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const logged = [];
  return { store, dir, logged, svc: createHouseholdService({ store, HWP: H, now, newId, production, log: (...a) => logged.push(a.join(' ')) }) };
}
const json = v => JSON.parse(JSON.stringify(v));
const stored = st => { const s = H.normalise(json(st)); delete s.audit; return json(s); };
// A household with its own reference, so several can live in one firm
const withRef = (st, ref) => { st.household.reference = ref; return st; };

test('create: version 1, cleaned state, author and a "created" audit entry', async () => {
  const { svc } = setup();
  const st = H.sample(); st.extra = 'dropped'; st.audit = [{ field: 'from the browser' }];
  assert.deepEqual(await svc.create(SAM, st), { id: '00000000-0000-4000-8000-000000000001', version: 1 });
  const rec = await svc.get(SAM, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(json(rec), { id: '00000000-0000-4000-8000-000000000001', version: 1, state: stored(st),
    createdAt: '2026-10-10T10:00:00.000Z', createdBy: 'sam', updatedAt: '2026-10-10T10:00:00.000Z', updatedBy: 'sam' });
  assert.equal(rec.state.extra, undefined); assert.equal(rec.state.audit, undefined);
  assert.deepEqual(await svc.audit(SAM, rec.id), [{ ts: '2026-10-10T10:00:00.000Z', user: 'sam', field: 'created', from: '', to: 'Harrington household' }]);
});

test('create with an idempotency key: the same user and key again returns the first reply and makes no second household', async () => {
  const { svc } = setup();
  const first = await svc.create(SAM, H.blank(), { idempotencyKey: 'click-0001' });
  assert.deepEqual(first, { id: '00000000-0000-4000-8000-000000000001', version: 1 });
  assert.deepEqual(await svc.create(SAM, H.blank(), { idempotencyKey: 'click-0001' }), first, 'a repeat (double-click, retried request) replays');
  assert.notEqual((await svc.create(SAM, H.blank(), { idempotencyKey: 'click-0002' })).id, first.id, 'another key is another household');
  assert.notEqual((await svc.create(CHRIS, H.blank(), { idempotencyKey: 'click-0001' })).id, first.id, 'keys are per user');
  assert.equal((await svc.list(SAM)).length, 3);
  // With a client reference, the repeat replays too: the household the key made is not a duplicate of itself
  const st = H.blank(); st.household.reference = 'REF-ONCE';
  const withRef = await svc.create(SAM, st, { idempotencyKey: 'click-0003' });
  assert.deepEqual(await svc.create(SAM, st, { idempotencyKey: 'click-0003' }), withRef, 'the same key replays, not 409');
  await assert.rejects(svc.create(SAM, st, { idempotencyKey: 'click-0004' }), { status: 409, code: 'duplicate_reference' }, 'another key with that reference is a duplicate');
  assert.equal((await svc.list(SAM)).length, 4);
  // The same key with a different request is refused, never answered with a reply that is not its own
  const changed = H.blank(); changed.household.name = 'Not the same request';
  await assert.rejects(svc.create(SAM, changed, { idempotencyKey: 'click-0001' }), { status: 422, message: 'This Idempotency-Key was already used for a different request' });
  assert.deepEqual(await svc.create(SAM, H.blank(), { idempotencyKey: 'click-0001' }), first, 'the original request still replays');
  assert.equal((await svc.list(SAM)).length, 4, 'nothing was made');
});

test('another firm reusing a key gets its own create and nothing about the first firm, whatever it sends', async () => {
  const { svc } = setup();
  const a = await svc.create(SAM, H.blank(), { idempotencyKey: 'shared-key-1' });
  const changed = H.blank(); changed.household.name = 'Different request';
  const b = await svc.create(OTHER_FIRM, changed, { idempotencyKey: 'shared-key-1' });
  assert.notEqual(b.id, a.id, "no replay of the first firm's reply, and no 422 that would say the key was used there");
  assert.deepEqual(await svc.create(OTHER_FIRM, changed, { idempotencyKey: 'shared-key-1' }), b, "the second firm's own repeat replays its own reply");
  await assert.rejects(svc.create(OTHER_FIRM, H.blank(), { idempotencyKey: 'shared-key-1' }), { status: 422 }, "judged against the second firm's own record only");
  assert.deepEqual(await svc.create(SAM, H.blank(), { idempotencyKey: 'shared-key-1' }), a, 'the first firm is unaffected');
  assert.equal(await svc.get(OTHER_FIRM, a.id), null, "the first firm's household is invisible");
  assert.deepEqual((await svc.list(OTHER_FIRM)).map(h => h.id), [b.id]);
  assert.deepEqual((await svc.list(SAM)).map(h => h.id), [a.id]);
  // Two identical requests at the same moment: still one household
  const { svc: svc2 } = setup();
  const both = await Promise.all([svc2.create(SAM, H.blank(), { idempotencyKey: 'same-key-1' }), svc2.create(SAM, H.blank(), { idempotencyKey: 'same-key-1' })]);
  assert.equal(both[0].id, both[1].id);
  assert.equal((await svc2.list(SAM)).length, 1);
});

test('create refuses a client reference that another household in the firm already has (409), in any spelling', async () => {
  const { svc } = setup();
  const { id } = await svc.create(SAM, H.sample()); // HH-0001
  await assert.rejects(svc.create(CHRIS, H.sample()), { status: 409, code: 'duplicate_reference', message: 'Another household in this firm already has this client reference' });
  await assert.rejects(svc.create(SAM, withRef(H.blank(), '  hh-0001 ')), { status: 409 });
  assert.equal((await svc.list(SAM)).length, 1);
  assert.equal(typeof (await svc.create(SAM, withRef(H.blank(), 'HH-0002'))).id, 'string', 'another reference is fine');
  assert.equal(typeof (await svc.create(SAM, H.blank())).id, 'string', 'no reference is fine');
  assert.equal(typeof (await svc.create(OTHER_FIRM, H.sample())).id, 'string', 'another firm may use the same reference');
  // A save keeping its own reference is fine; a save that would take another household's reference is refused
  const st = json((await svc.get(SAM, id)).state); st.household.name = 'Renamed';
  assert.deepEqual(await svc.save(SAM, id, { version: 1, state: st }), { version: 2, changes: 1 });
  const { id: two } = await svc.create(SAM, withRef(H.blank(), 'HH-0003'));
  const taken = json((await svc.get(SAM, two)).state); taken.household.reference = 'hh-0001';
  await assert.rejects(svc.save(SAM, two, { version: 1, state: taken }), { status: 409, code: 'duplicate_reference', message: 'Another household in this firm already has this client reference' });
  assert.equal((await svc.get(SAM, two)).version, 1, 'nothing saved');
});

test('create and save refuse a value outside the field rules (400 invalid_field), naming the field and the rule, and store nothing', async () => {
  const { svc } = setup();
  const bad = H.blank(); bad.household.willsInPlace = 'maybe'; bad.members = [{ ...H.defaults('members'), dob: 'SECRET' }];
  await assert.rejects(svc.create(SAM, bad), e => {
    assert.equal(e.status, 400); assert.equal(e.code, 'invalid_field');
    assert.deepEqual(e.errors, [{ field: 'household.willsInPlace', message: 'must be yes or no' }, { field: 'members[0].dob', message: 'must be a date (YYYY-MM-DD)' }]);
    assert.equal(e.message, 'Invalid household: household.willsInPlace must be yes or no'); assert.ok(!/SECRET|maybe/.test(e.message)); return true;
  });
  assert.deepEqual(await svc.list(SAM), [], 'nothing created');
  const { id } = await svc.create(SAM, H.blank());
  const edit = H.blank(); edit.accounts = [{ ...H.defaults('accounts'), value: 'SECRET' }];
  await assert.rejects(svc.save(SAM, id, { version: 1, state: edit }), { status: 400, code: 'invalid_field', message: 'Invalid household: accounts[0].value must be a number' });
  assert.equal((await svc.get(SAM, id)).version, 1, 'nothing saved');
  // canonical values are what gets stored: a numeric string becomes a number, "true" a boolean
  const fine = H.blank(); fine.accounts = [{ ...H.defaults('accounts'), value: '£12,500' }]; fine.household.willsInPlace = 'true';
  assert.equal((await svc.save(SAM, id, { version: 1, state: fine })).version, 2);
  const rec = await svc.get(SAM, id);
  assert.equal(rec.state.accounts[0].value, 12500); assert.equal(rec.state.household.willsInPlace, true);
  // more than twenty problems: the first twenty are listed
  const many = H.blank(); many.contacts = Array.from({ length: 25 }, () => ({ ...H.defaults('contacts'), date: 'nope' }));
  await assert.rejects(svc.create(SAM, many), e => e.errors.length === 20);
});

test('list: a household that cannot be read is skipped and logged with its id; the rest still list', async () => {
  const { svc, dir, logged } = setup();
  const a = H.sample(); a.household.name = 'Readable';
  const { id: good } = await svc.create(SAM, a);
  const { id: bad } = await svc.create(SAM, H.blank());
  fs.writeFileSync(path.join(dir, 'households', bad, 'current.json'), '{not json');
  const list = await svc.list(SAM);
  assert.deepEqual(list.map(x => x.id), [good]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(`unreadable household ${bad}`));
});

test('list: summaries from core.js, most recently changed first; another firm lists nothing', async () => {
  const { svc } = setup();
  const a = H.sample(); a.household.name = 'Older';
  const b = H.blank(); b.household.name = 'Newer';
  await svc.create(SAM, a); await svc.create(CHRIS, b);
  const list = await svc.list(SAM);
  assert.deepEqual(list.map(x => x.name), ['Newer', 'Older']);
  const E = H.bind(H.normalise(stored(a))); const O = E.onboarding(E.compute()); const R = E.reviews(O);
  assert.deepEqual(json(list[1]), json({ id: '00000000-0000-4000-8000-000000000001', name: 'Older', reference: a.household.reference, stage: O.stage, rating: O.rating,
    nextReview: O.nextReview, blockers: O.blockerCount, due: R.nextDue, overdue: R.overdue, tasks: H.openTasks(H.normalise(stored(a))), version: 1, updatedAt: '2026-10-10T10:00:00.000Z', updatedBy: 'sam' }));
  assert.deepEqual(await svc.list(OTHER_FIRM), []);
  assert.equal(await svc.get(OTHER_FIRM, list[1].id), null);
  assert.equal(await svc.audit(OTHER_FIRM, list[1].id), null);
  assert.deepEqual(await svc.save(OTHER_FIRM, list[1].id, { version: 1, state: a }), { notFound: true });
});

test('save: nothing changed means no new version', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(SAM, st);
  assert.deepEqual(await svc.save(CHRIS, id, { version: 1, state: st }), { version: 1, changes: 0 });
  assert.equal((await svc.get(SAM, id)).updatedBy, 'sam');
  assert.equal((await svc.audit(SAM, id)).length, 1);
});

test('save: changes make version 2 with one audit entry per changed field', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(SAM, st);
  const ed = json(st); ed.household.reference = 'HH-NEW'; ed.members[1].poaType = 'bank';
  assert.deepEqual(await svc.save(CHRIS, id, { version: 1, state: ed }), { version: 2, changes: 2 });
  const rec = await svc.get(SAM, id);
  assert.equal(rec.version, 2); assert.equal(rec.updatedBy, 'chris'); assert.equal(rec.createdBy, 'sam');
  assert.equal(rec.updatedAt, '2026-10-10T10:00:01.000Z'); assert.deepEqual(json(rec.state), stored(ed));
  const changes = (await svc.audit(SAM, id)).slice(0, 2);
  assert.deepEqual(changes.map(c => c.field).sort(), ['household.reference', 'members[1].poaType']);
  for (const c of changes) { assert.equal(c.user, 'chris'); assert.equal(c.version, 2); assert.equal(c.ts, '2026-10-10T10:00:01.000Z'); }
  assert.deepEqual(changes.find(c => c.field === 'household.reference'), { ts: '2026-10-10T10:00:01.000Z', user: 'chris', field: 'household.reference', from: 'HH-0001', to: 'HH-NEW', version: 2 });
});

test('save on an old version: conflict with who saved last; nothing saved', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(SAM, st);
  const ed = json(st); ed.household.reference = 'HH-NEW';
  await svc.save(CHRIS, id, { version: 1, state: ed });
  const again = json(st); again.household.reference = 'HH-MINE';
  assert.deepEqual(await svc.save(SAM, id, { version: 1, state: again }), { conflict: { version: 2, updatedBy: 'chris', updatedAt: '2026-10-10T10:00:01.000Z' } });
  assert.equal((await svc.get(SAM, id)).state.household.reference, 'HH-NEW');
});

test('two saves of the same version at once: exactly one wins', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(SAM, st);
  const x = json(st); x.household.reference = 'X'; const y = json(st); y.household.reference = 'Y';
  const results = await Promise.all([svc.save(SAM, id, { version: 1, state: x }), svc.save(CHRIS, id, { version: 1, state: y })]);
  assert.equal(results.filter(r => r.version === 2).length, 1);
  assert.equal(results.filter(r => r.conflict).length, 1);
  assert.equal((await svc.get(SAM, id)).version, 2);
});

test('unknown household: get null, audit null, save not found', async () => {
  const { svc } = setup();
  const id = '00000000-0000-4000-8000-999999999999';
  assert.equal(await svc.get(SAM, id), null);
  assert.equal(await svc.audit(SAM, id), null);
  assert.deepEqual(await svc.save(SAM, id, { version: 1, state: H.sample() }), { notFound: true });
});

test('in production a sample household is refused on create and on save (400); elsewhere it is allowed', async () => {
  const { svc: prod } = setup({ production: true });
  await assert.rejects(prod.create(SAM, H.sample()), { status: 400, code: 'sample_refused', message: 'Sample households are not allowed in production' });
  const { id } = await prod.create(SAM, H.blank());
  await assert.rejects(prod.save(SAM, id, { version: 1, state: H.sample() }), { status: 400, code: 'sample_refused', message: 'Sample households are not allowed in production' });
  assert.equal((await prod.get(SAM, id)).version, 1, 'nothing was saved');
  assert.equal((await prod.list(SAM)).length, 1);
  const { svc: dev } = setup();
  assert.equal(typeof (await dev.create(SAM, H.sample())).id, 'string');
});

test('audit is capped at 5000 entries, newest first', async () => {
  assert.equal(AUDIT_LIMIT, 5000);
  const audit = Array.from({ length: 5003 }, (_, i) => ({ i }));
  const store = { forFirm: () => ({ get: async () => ({ id: 'x' }), audit: async () => audit, logAccess: async () => {} }) };
  const svc = createHouseholdService({ store, HWP: H });
  const out = await svc.audit(SAM, 'x');
  assert.equal(out.length, 5000); assert.equal(out[0].i, 0);
});

test('a household the rules cannot evaluate still lists, with stage "Error"', () => {
  const broken = { ...H, bind: () => { throw new Error('boom'); } };
  const s = summarise(broken, { id: 'x', version: 3, state: H.sample(), updatedAt: 't', updatedBy: 'u' });
  assert.equal(s.stage, 'Error'); assert.equal(s.name, 'Harrington household'); assert.equal(s.version, 3);
});
