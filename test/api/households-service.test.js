// apps/api/src/services/households.js: the household flow without HTTP. A fixed clock and ids
// make every result exact; expected summaries are worked out with packages/core directly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../../packages/core/core.js');
const { createHouseholdService, summarise, AUDIT_LIMIT } = require('../../apps/api/src/services/households.js');
const { createFileStore } = require('../../apps/api/src/repositories');
const { createSealer } = require('../../apps/api/src/crypto/seal.js');

function setup() {
  const store = createFileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-svc-')), createSealer(null));
  let t = 0, n = 0;
  const now = () => `2026-10-10T10:00:${String(t++).padStart(2, '0')}.000Z`;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  return { store, svc: createHouseholdService({ store, HWP: H, now, newId }) };
}
const json = v => JSON.parse(JSON.stringify(v));
const stored = st => { const s = H.normalise(json(st)); delete s.audit; return json(s); };

test('create: version 1, cleaned state, author and a "created" audit entry', async () => {
  const { svc } = setup();
  const st = H.sample(); st.extra = 'dropped'; st.audit = [{ field: 'from the browser' }];
  assert.deepEqual(await svc.create(st, 'sam'), { id: '00000000-0000-4000-8000-000000000001', version: 1 });
  const rec = await svc.get('00000000-0000-4000-8000-000000000001');
  assert.deepEqual(json(rec), { id: '00000000-0000-4000-8000-000000000001', version: 1, state: stored(st),
    createdAt: '2026-10-10T10:00:00.000Z', createdBy: 'sam', updatedAt: '2026-10-10T10:00:00.000Z', updatedBy: 'sam' });
  assert.equal(rec.state.extra, undefined); assert.equal(rec.state.audit, undefined);
  assert.deepEqual(await svc.audit(rec.id), [{ ts: '2026-10-10T10:00:00.000Z', user: 'sam', field: 'created', from: '', to: 'Harrington household' }]);
});

test('list: summaries from core.js, most recently changed first', async () => {
  const { svc } = setup();
  const a = H.sample(); a.household.name = 'Older';
  const b = H.blank(); b.household.name = 'Newer';
  await svc.create(a, 'sam'); await svc.create(b, 'chris');
  const list = await svc.list();
  assert.deepEqual(list.map(x => x.name), ['Newer', 'Older']);
  const E = H.bind(H.normalise(stored(a))); const O = E.onboarding(E.compute()); const R = E.reviews(O);
  assert.deepEqual(json(list[1]), json({ id: '00000000-0000-4000-8000-000000000001', name: 'Older', reference: a.household.reference, stage: O.stage, rating: O.rating,
    nextReview: O.nextReview, blockers: O.blockerCount, due: R.nextDue, overdue: R.overdue, tasks: H.openTasks(H.normalise(stored(a))), version: 1, updatedAt: '2026-10-10T10:00:00.000Z', updatedBy: 'sam' }));
});

test('save: nothing changed means no new version', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(st, 'sam');
  assert.deepEqual(await svc.save(id, { version: 1, state: st }, 'chris'), { version: 1, changes: 0 });
  assert.equal((await svc.get(id)).updatedBy, 'sam');
  assert.equal((await svc.audit(id)).length, 1);
});

test('save: changes make version 2 with one audit entry per changed field', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(st, 'sam');
  const ed = json(st); ed.household.reference = 'HH-NEW'; ed.members[1].poaType = 'bank';
  assert.deepEqual(await svc.save(id, { version: 1, state: ed }, 'chris'), { version: 2, changes: 2 });
  const rec = await svc.get(id);
  assert.equal(rec.version, 2); assert.equal(rec.updatedBy, 'chris'); assert.equal(rec.createdBy, 'sam');
  assert.equal(rec.updatedAt, '2026-10-10T10:00:01.000Z'); assert.deepEqual(json(rec.state), stored(ed));
  const changes = (await svc.audit(id)).slice(0, 2);
  assert.deepEqual(changes.map(c => c.field).sort(), ['household.reference', 'members[1].poaType']);
  for (const c of changes) { assert.equal(c.user, 'chris'); assert.equal(c.version, 2); assert.equal(c.ts, '2026-10-10T10:00:01.000Z'); }
  assert.deepEqual(changes.find(c => c.field === 'household.reference'), { ts: '2026-10-10T10:00:01.000Z', user: 'chris', field: 'household.reference', from: 'HH-0001', to: 'HH-NEW', version: 2 });
});

test('save on an old version: conflict with who saved last; nothing saved', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(st, 'sam');
  const ed = json(st); ed.household.reference = 'HH-NEW';
  await svc.save(id, { version: 1, state: ed }, 'chris');
  const again = json(st); again.household.reference = 'HH-MINE';
  assert.deepEqual(await svc.save(id, { version: 1, state: again }, 'sam'), { conflict: { version: 2, updatedBy: 'chris', updatedAt: '2026-10-10T10:00:01.000Z' } });
  assert.equal((await svc.get(id)).state.household.reference, 'HH-NEW');
});

test('two saves of the same version at once: exactly one wins', async () => {
  const { svc } = setup();
  const st = H.sample(); const { id } = await svc.create(st, 'sam');
  const x = json(st); x.household.reference = 'X'; const y = json(st); y.household.reference = 'Y';
  const results = await Promise.all([svc.save(id, { version: 1, state: x }, 'sam'), svc.save(id, { version: 1, state: y }, 'chris')]);
  assert.equal(results.filter(r => r.version === 2).length, 1);
  assert.equal(results.filter(r => r.conflict).length, 1);
  assert.equal((await svc.get(id)).version, 2);
});

test('unknown household: get null, audit null, save not found', async () => {
  const { svc } = setup();
  const id = '00000000-0000-4000-8000-999999999999';
  assert.equal(await svc.get(id), null);
  assert.equal(await svc.audit(id), null);
  assert.deepEqual(await svc.save(id, { version: 1, state: H.sample() }, 'sam'), { notFound: true });
});

test('audit is capped at 5000 entries, newest first', async () => {
  assert.equal(AUDIT_LIMIT, 5000);
  const audit = Array.from({ length: 5003 }, (_, i) => ({ i }));
  const store = { get: async () => ({ id: 'x' }), audit: async () => audit };
  const svc = createHouseholdService({ store, HWP: H });
  const out = await svc.audit('x');
  assert.equal(out.length, 5000); assert.equal(out[0].i, 0);
});

test('a household the rules cannot evaluate still lists, with stage "Error"', () => {
  const broken = { ...H, bind: () => { throw new Error('boom'); } };
  const s = summarise(broken, { id: 'x', version: 3, state: H.sample(), updatedAt: 't', updatedBy: 'u' });
  assert.equal(s.stage, 'Error'); assert.equal(s.name, 'Harrington household'); assert.equal(s.version, 3);
});
