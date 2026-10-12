// Life-event scenarios: each changes a copy of the household and re-runs the model.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../packages/core/core.js');

// The rules depend on today's date (reviews, expiries, the sample household's own dates). Every test
// runs on the same fixed day, so results never change with the calendar.
test.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T10:00:00Z') });

const run = s => H.bind(s).scenarios();
const get = (R, id) => R.list.find(x => x.id === id);

test('scenarios never change the household itself', () => {
  const s = H.sample(); const before = JSON.stringify(s);
  run(s);
  assert.equal(JSON.stringify(s), before);
});

test('the sample couple gets all twelve scenarios, with death and separation only for couples', () => {
  const R = run(H.sample());
  assert.deepEqual(R.list.map(x => x.id), ['death-P1', 'death-P2', 'divorce', 'care', 'redundancy', 'illness', 'early', 'market', 'rates', 'business', 'inheritance', 'longevity']);
  const single = H.sample(); single.members = single.members.filter(m => m.ref !== 'P2');
  const ids = run(single).list.map(x => x.id);
  assert.ok(!ids.some(id => id.startsWith('death') || id === 'divorce'));
});

test('death: income stops, cover pays the survivor, survivor pension starts, spending falls', () => {
  const x = get(run(H.sample()), 'death-P2');
  assert.ok(x.notes.some(n => /Priya.s income stops/.test(n)));
  assert.ok(x.notes.some(n => /Death in service pays £84,000 to James/.test(n)));
  assert.ok(x.notes.some(n => /37.5% spouse.s pension to James/.test(n)));
  assert.ok(x.notes.some(n => /spending falls to 75%/.test(n)));
});

test('inheritance adds the lump sum to net worth and 40% of it to IHT; a market fall lowers net worth', () => {
  const R = run(H.sample());
  const inh = get(R, 'inheritance');
  assert.ok(Math.abs((inh.after.nw - R.before.nw) - 250000) < 1);
  assert.ok(Math.abs((inh.after.iht - R.before.iht) - 100000) < 1);
  assert.ok(get(R, 'market').after.nw < R.before.nw);
  assert.ok(get(R, 'care').after.nw < R.before.nw);
  assert.ok(get(R, 'longevity').after.nw < R.before.nw);
});

test('redundancy, illness and early retirement all reduce net worth (future earnings are taxed at their own rate)', () => {
  const R = run(H.sample());
  for (const id of ['redundancy', 'illness', 'early']) assert.ok(get(R, id).after.nw < R.before.nw, id);
  const s = H.sample(); const base = H.bind(s).compute().tot.HH.hc;
  s.income.find(i => i.owner === 'P2' && i.type === 'Employment salary').startAge = 48;
  assert.ok(H.bind(s).compute().tot.HH.hc < base, 'delaying earnings must not raise human capital');
});

test('scenario assumptions are saved with the file and change the result', () => {
  const s = H.sample();
  assert.equal(s.scen.marketFall, 25);
  const a = get(run(s), 'market').after.nw;
  s.scen.marketFall = 40;
  assert.ok(get(run(s), 'market').after.nw < a);
  s.scen.who = 'P2';
  assert.equal(run(s).who, 'P2');
  assert.match(get(run(s), 'redundancy').title, /Priya/);
});
