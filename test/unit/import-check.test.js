// apps/web/public/js/hooks/io/import-check.js: every unrecognised dropdown value in an imported file is
// listed before anything is applied, so the file can be fixed in one pass. (A browser module with
// no browser dependencies, so it is tested here as it is.)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('../../packages/core/core.js');

const mod = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'apps', 'web', 'public', 'js', 'hooks', 'io', 'import-check.js')).href);

test('a clean file lists nothing: blank, the sample, and option values that look like numbers', async () => {
  const { unknownDropdowns } = await mod();
  assert.deepEqual(unknownDropdowns(H, H.normalise(H.blank())), []);
  assert.deepEqual(unknownDropdowns(H, H.normalise(H.sample())), []);
  const s = H.normalise(H.blank()); s.rtq = [{ ...H.defaults('rtq'), atr1: 3 }]; s.members = [{ ...H.defaults('members'), role: 'partner' }];
  assert.deepEqual(unknownDropdowns(H, s), []);
});

test('every unrecognised dropdown value is listed with its sheet, entry and field label', async () => {
  const { unknownDropdowns, describeUnknown } = await mod();
  const s = H.normalise(H.blank());
  s.household.region = 'Mars';
  s.members = [H.defaults('members'), { ...H.defaults('members'), role: 'Wizard', health: 'Fine' }];
  s.accounts = [{ ...H.defaults('accounts'), wrapper: 'stocks & shares isa' }];
  const list = unknownDropdowns(H, s);
  assert.deepEqual(list, [
    { sheet: 'Household', entry: null, field: 'UK nation', value: 'Mars' },
    { sheet: 'Members', entry: 2, field: 'Role', value: 'Wizard' },
    { sheet: 'Members', entry: 2, field: 'Health', value: 'Fine' },
    { sheet: 'Accounts', entry: 1, field: 'Wrapper', value: 'stocks & shares isa' },
  ]);
  assert.deepEqual(list.map(describeUnknown), ['Household, UK nation: "Mars"', 'Members entry 2, Role: "Wizard"', 'Members entry 2, Health: "Fine"', 'Accounts entry 1, Wrapper: "stocks & shares isa"']);
});

test('what the spreadsheet importer makes of an unknown dropdown text is exactly what gets listed', async () => {
  const { unknownDropdowns } = await mod();
  const f = H.fieldsOf(H.SCHEMA.members).find(x => x.k === 'role');
  const s = H.normalise(H.blank()); s.members = [{ ...H.defaults('members'), role: H.coerce(f, 'Grandparent') }];
  assert.deepEqual(unknownDropdowns(H, s).map(u => u.value), ['Grandparent']);
  assert.equal(H.coerce(f, 'spouse / partner'), 'partner', 'a label in any case is matched to its option, so it is not listed');
});
