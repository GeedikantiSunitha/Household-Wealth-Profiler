// backend/src/services/records.js (Phase 4): the access log, exports, the retention clock, approved
// purge and the subject access export, without HTTP. The same tests run on the file store and, when
// TEST_DATABASE_URL is set, on PostgreSQL as the real app role (hwp_app, row-level security forced,
// migrations run as hwp_owner in a schema of their own), so both stores keep one behaviour.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../../packages/core/core.js');
const { createHouseholdService } = require('../../backend/src/services/households.js');
const { createRecordsService, addYears, day } = require('../../backend/src/services/records.js');
const { createStore, DEFAULT_FIRM_ID } = require('../../backend/src/repositories');
const { createSealer } = require('../../backend/src/crypto/seal.js');
const { migrate, pgClient } = require('../../db/migrate.js');

const ROOT = path.join(__dirname, '..', '..');
const BASE_URL = require('./test-db.js').testDatabaseUrl();
const FIRM_B = '0f1e0000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-10-13T12:00:00Z');

test('addYears and day: calendar arithmetic for the retention clock', () => {
  assert.equal(addYears('2020-10-13', 5), '2025-10-13');
  assert.equal(addYears('2016-02-29', 5), '2021-03-01', '29 February runs to 1 March');
  assert.equal(day('2026-02-29'), null, 'not a real day');
  assert.equal(day('2026-1-1'), null);
  assert.equal(day('1899-12-31'), null);
  assert.equal(day('2024-02-29'), '2024-02-29');
});

function suite(name, open, { skip } = {}) {
  test.describe(`records service on ${name}`, { skip }, () => {
    let store, end, users, households, records, prod;
    const ctxs = {};
    const read = async (id) => store.forFirm(DEFAULT_FIRM_ID).accessLog(id);
    const newHousehold = async (ref, ctx = ctxs.ann) => { const st = H.sample(); st.isSample = false; st.household.reference = ref; return (await households.create(ctx, st)).id; };

    test.before(async () => {
      ({ store, end, users } = await open());
      households = createHouseholdService({ store, HWP: H });
      records = createRecordsService({ store, HWP: H, now: () => NOW });
      prod = createRecordsService({ store, HWP: H, now: () => NOW, production: true });
      const ctx = (key, role, firmId = DEFAULT_FIRM_ID) => ({ user: `${key}@example.com`, userId: users[key], firmId, role, session: { id: key } });
      Object.assign(ctxs, { ann: ctx('ann', 'admin'), bob: ctx('bob', 'compliance'), ada: ctx('ada', 'adviser'), basic: { user: 'sam', firmId: DEFAULT_FIRM_ID }, other: ctx('ann', 'admin', FIRM_B) });
    }, { timeout: 120000 });
    test.after(async () => { if (end) await end(); });

    test('reads are logged before they return: open, audit trail, and an id that is not there (not_found)', async () => {
      const id = await newHousehold('LOG-1');
      await households.get(ctxs.ada, id);
      await households.audit(ctxs.ada, id);
      const ghost = crypto.randomUUID();
      assert.equal(await households.get(ctxs.ada, ghost), null);
      const log = await read(id);
      assert.deepEqual(log.map(e => [e.action, e.actor, e.outcome]), [['audit', 'ada@example.com', 'ok'], ['read', 'ada@example.com', 'ok']]);
      assert.match(log[0].at, /^\d{4}-\d\d-\d\dT/);
      assert.deepEqual((await read(ghost)).map(e => [e.action, e.outcome]), [['read', 'not_found']]);
    });

    test('an export made in the browser is logged with its kind; an unknown kind is 400, an unknown household null', async () => {
      const id = await newHousehold('EXP-1');
      assert.deepEqual(await records.logExport(ctxs.ada, id, 'excel'), { logged: true });
      await records.logExport(ctxs.ada, id, 'print');
      await assert.rejects(records.logExport(ctxs.ada, id, 'pdf'), { status: 400, code: 'bad_request' });
      assert.equal(await records.logExport(ctxs.ada, crypto.randomUUID(), 'json'), null);
      assert.deepEqual((await read(id)).filter(e => e.action === 'export').map(e => e.detail), ['print', 'excel']);
    });

    test('only admin and compliance users reach the records actions; an adviser is refused (403) and the refusal is logged', async () => {
      const id = await newHousehold('ROLE-1');
      for (const call of [() => records.overview(ctxs.ada), () => records.accessLog(ctxs.ada, id), () => records.setRelationship(ctxs.ada, id, { endedOn: '2015-01-01' }),
        () => records.requestPurge(ctxs.ada, id, { reason: 'x' }), () => records.subjectAccess(ctxs.ada, id), () => records.decidePurge(ctxs.ada, crypto.randomUUID(), { approve: false })]) {
        await assert.rejects(call(), { status: 403, code: 'forbidden' });
      }
      assert.deepEqual((await read(id)).map(e => [e.action, e.outcome]), [['subject_access', 'forbidden'], ['purge_request', 'forbidden'], ['retention', 'forbidden'], ['access_log', 'forbidden']]);
      assert.equal((await records.accessLog(ctxs.bob, id)).length, 4, 'compliance reads the access log');
      assert.ok(Array.isArray((await records.overview(ctxs.basic)).households), 'development Basic sign-in (no role) is allowed');
      assert.ok(Array.isArray((await records.overview({ ...ctxs.ada, roles: ['adviser', 'compliance'] })).households), 'an adviser who also holds the compliance role is a manager (several roles on one membership)');
      await assert.rejects(records.overview({ ...ctxs.ada, roles: ['adviser'] }), { status: 403, code: 'forbidden' });
      await assert.rejects(prod.overview(ctxs.basic), { status: 403 }, 'production refuses a call without a session');
    });

    test('the retention clock: the day the relationship ended, plus the retention period; recorded in the change audit; reopened with null', async () => {
      const id = await newHousehold('RET-1');
      await assert.rejects(records.setRelationship(ctxs.ann, id, {}), { status: 400 });
      await assert.rejects(records.setRelationship(ctxs.ann, id, { endedOn: '2026-13-01' }), { status: 400 });
      await assert.rejects(records.setRelationship(ctxs.ann, id, { endedOn: '2026-10-14' }), { status: 400, message: /still to come/ });
      assert.equal(await records.setRelationship(ctxs.ann, crypto.randomUUID(), { endedOn: '2020-01-01' }), null);
      assert.deepEqual(await records.setRelationship(ctxs.ann, id, { endedOn: '2026-10-13' }), { endedOn: '2026-10-13', retentionUntil: '2031-10-13' });
      assert.deepEqual(await records.setRelationship(ctxs.ann, id, { endedOn: '2026-10-13' }), { endedOn: '2026-10-13', retentionUntil: '2031-10-13' }, 'the same day again changes nothing');
      assert.deepEqual(await records.setRelationship(ctxs.bob, id, { endedOn: null }), { endedOn: null, retentionUntil: null });
      const audit = (await households.audit(ctxs.ann, id)).filter(a => a.field === 'relationship.endedOn');
      assert.deepEqual(audit.map(a => [a.user, a.from, a.to]), [['bob@example.com', '2026-10-13', ''], ['ann@example.com', '', '2026-10-13']]);
      const h = (await records.overview(ctxs.ann)).households.find(x => x.id === id);
      assert.deepEqual([h.endedOn, h.retentionUntil, h.eligible], [null, null, false]);
    });

    test('a purge is requested only after the retention period, with a reason, once at a time; the clock is fixed while it waits', async () => {
      const id = await newHousehold('PRG-1');
      await assert.rejects(records.requestPurge(ctxs.ann, id, { reason: 'ended' }), { status: 409, code: 'relationship_open' });
      await records.setRelationship(ctxs.ann, id, { endedOn: '2022-01-01' });
      await assert.rejects(records.requestPurge(ctxs.ann, id, { reason: 'ended' }), { status: 409, code: 'retention_not_ended', message: /2027-01-01/ });
      await records.setRelationship(ctxs.ann, id, { endedOn: '2015-03-01' });
      await assert.rejects(records.requestPurge(ctxs.ann, id, { reason: '  ' }), { status: 400 });
      await assert.rejects(records.requestPurge(ctxs.ann, id, { reason: 'x'.repeat(501) }), { status: 400 });
      const req = await records.requestPurge(ctxs.ann, id, { reason: 'Five years since the relationship ended' });
      assert.equal(req.status, 'pending'); assert.equal(req.retentionUntil, '2020-03-01'); assert.equal(req.reason, 'Five years since the relationship ended'); assert.equal(req.requestedBy, 'ann@example.com');
      await assert.rejects(records.requestPurge(ctxs.bob, id, { reason: 'again' }), { status: 409, code: 'purge_pending' });
      await assert.rejects(records.setRelationship(ctxs.bob, id, { endedOn: null }), { status: 409, code: 'purge_pending' });
      const ov = await records.overview(ctxs.bob);
      assert.equal(ov.households.find(x => x.id === id).eligible, true);
      assert.equal(ov.requests.find(q => q.id === req.id).householdName, 'Harrington household');
    });

    test('two people: the requester cannot approve (403 same_person, logged) but may withdraw; a decided request stays decided', async () => {
      const id = await newHousehold('PRG-2');
      await records.setRelationship(ctxs.ann, id, { endedOn: '2015-03-01' });
      const req = await records.requestPurge(ctxs.ann, id, { reason: 'due' });
      await assert.rejects(records.decidePurge(ctxs.ann, req.id, { approve: true }), { status: 403, code: 'same_person' });
      assert.deepEqual((await read(id)).slice(0, 1).map(e => [e.action, e.outcome, e.detail]), [['purge_approve', 'forbidden', 'own request']]);
      const r = await records.decidePurge(ctxs.ann, req.id, { approve: false, note: 'withdrawn' });
      assert.equal(r.request.status, 'rejected'); assert.equal(r.request.note, 'withdrawn');
      await assert.rejects(records.decidePurge(ctxs.bob, req.id, { approve: true }), { status: 409, code: 'already_decided' });
      assert.ok(await households.get(ctxs.ann, id), 'still there');
      assert.equal(await records.decidePurge(ctxs.bob, crypto.randomUUID(), { approve: true }), null);
    });

    test('approved by a second person: the household, every version, its change audit and its retention go; the register and the access log stay', async () => {
      const id = await newHousehold('PRG-3');
      const rec = await households.get(ctxs.ann, id);
      const st = rec.state; st.household.adviser = 'Someone else';
      await households.save(ctxs.ann, id, { version: 1, state: st });
      await records.setRelationship(ctxs.ann, id, { endedOn: '2015-03-01' });
      const req = await records.requestPurge(ctxs.ann, id, { reason: 'retention ended' });
      const other = await records.decidePurge(ctxs.other, req.id, { approve: true });
      assert.equal(other, null, 'another firm cannot even see the request');
      const out = await records.decidePurge(ctxs.bob, req.id, { approve: true, note: 'checked: no hold, no complaint' });
      assert.deepEqual(out, { purged: true, householdId: id, counts: { households: 1, versions: 2, auditEntries: 3, retention: 1 } });
      assert.equal(await households.get(ctxs.ann, id), null);
      assert.equal(await households.audit(ctxs.ann, id), null);
      assert.ok(!(await households.list(ctxs.ann)).some(h => h.id === id));
      assert.equal(await records.subjectAccess(ctxs.ann, id), null);
      const reg = (await records.overview(ctxs.ann)).requests.find(q => q.id === req.id);
      assert.equal(reg.status, 'purged'); assert.equal(reg.decidedBy, 'bob@example.com'); assert.equal(reg.note, 'checked: no hold, no complaint'); assert.equal(reg.householdName, '');
      assert.deepEqual(reg.counts, out.counts);
      assert.ok((await read(id)).some(e => e.action === 'read' && e.outcome === 'ok'), 'who read it before the purge is still on record');
      await assert.rejects(records.decidePurge(ctxs.basic, req.id, { approve: true }), { status: 409, code: 'already_decided' });
    });

    test('the subject access export holds everything kept for the household, lists every person for redaction, and is itself logged', async () => {
      const id = await newHousehold('SAR-1');
      await households.get(ctxs.ada, id);
      await records.setRelationship(ctxs.ann, id, { endedOn: '2026-01-31' });
      const p = await records.subjectAccess(ctxs.bob, id);
      assert.equal(p.kind, 'subject-access-export'); assert.equal(p.format, 1);
      assert.equal(p.generatedBy, 'bob@example.com'); assert.equal(p.generatedAt, NOW.toISOString());
      assert.deepEqual(p.household, { id, name: 'Harrington household', reference: 'SAR-1' });
      assert.deepEqual(p.people.map(x => x.role), H.sample().members.map(m => m.role));
      assert.ok(p.people.every(x => x.name && x.ref));
      assert.equal(p.record.id, id); assert.equal(p.versions.length, 1);
      assert.deepEqual(p.changeAudit.map(a => a.field), ['relationship.endedOn', 'created']);
      assert.ok(p.accessLog.some(e => e.action === 'read' && e.actor === 'ada@example.com'));
      assert.deepEqual(p.retention, { endedOn: '2026-01-31', retentionUntil: '2031-01-31' });
      assert.ok(p.notice.some(n => /Article 15\(4\)/.test(n)));
      assert.equal((await read(id))[0].action, 'subject_access');
    });

    test('firms stay apart: firm B sees none of firm A retention, requests or access log', async () => {
      const id = await newHousehold('ISO-1');
      await records.setRelationship(ctxs.ann, id, { endedOn: '2015-03-01' });
      await records.requestPurge(ctxs.ann, id, { reason: 'due' });
      const b = await records.overview(ctxs.other);
      assert.equal(b.households.length, 0); assert.equal(b.requests.length, 0);
      assert.equal(await records.accessLog(ctxs.other, id), null);
      assert.equal(await records.setRelationship(ctxs.other, id, { endedOn: null }), null);
      assert.deepEqual((await store.forFirm(FIRM_B).accessLog(id)).map(e => [e.action, e.outcome]), [['retention', 'not_found'], ['access_log', 'not_found']], "firm B's attempts are logged in firm B");
      assert.ok(!(await read(id)).some(e => e.outcome === 'not_found'), "and not in firm A's log");
    });
  });
}

suite('the file store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-records-'));
  const store = createStore({ dataDir: dir, databaseUrl: '' }, createSealer(crypto.randomBytes(32)));
  await store.init();
  const users = { ann: crypto.randomUUID(), bob: crypto.randomUUID(), ada: crypto.randomUUID() };
  return { store, users, end: async () => fs.rmSync(dir, { recursive: true, force: true }) };
});

suite('PostgreSQL (as hwp_app)', async () => {
  const { Client } = require('pg');
  const schema = 'hwp_records_' + crypto.randomBytes(4).toString('hex');
  const PW = crypto.randomBytes(12).toString('hex');
  const urlFor = user => { const u = new URL(BASE_URL); u.username = user; u.password = PW; u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
  const admin = new Client({ connectionString: BASE_URL }); await admin.connect();
  await require('./test-db.js').ensureRoles(admin, PW);
  await admin.query(`create schema ${schema} authorization hwp_owner`);
  await admin.query(`grant usage on schema ${schema} to hwp_app`);
  const owner = new Client({ connectionString: urlFor('hwp_owner') }); await owner.connect();
  await migrate(pgClient(owner), { dir: path.join(ROOT, 'db', 'migrations') });
  await owner.query(`insert into firms (id, name) values ($1, 'Firm B')`, [FIRM_B]);
  const users = {};
  for (const k of ['ann', 'bob', 'ada']) users[k] = (await owner.query('insert into users (email, name) values ($1, $2) returning id', [`${k}@example.com`, k])).rows[0].id;
  await owner.end();
  const store = createStore({ databaseUrl: urlFor('hwp_app'), databasePoolMax: 2, root: ROOT }, createSealer(crypto.randomBytes(32)));
  await store.ready();
  return { store, users, end: async () => { await store.end(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); } };
}, { skip: !BASE_URL && 'set TEST_DATABASE_URL to run' });
