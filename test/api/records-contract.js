// Records API contract (Phase 4): the replies of the access log, export log, retention, purge and
// subject access routes, shared by server.test.js (file storage) and postgres.test.js (PostgreSQL)
// so both storage modes answer alike. Uses the development Basic sign-in (no role: allowed; the role
// checks are in records-service.test.js). ctx() returns { base, sam, chris } as for apiContract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('../../packages/core/core.js');

const J = { 'Content-Type': 'application/json' };
const keys = o => Object.keys(o).sort();

function recordsContract(ctx) {
  test.describe('records API contract', () => {
    let base, sam, chris;
    const call = (method, p, { who, body } = {}) => fetch(base + p, { method, headers: { ...(who || {}), ...(body !== undefined ? J : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const create = async ref => { const st = H.blank(); st.household.name = 'Records ' + ref; st.household.reference = ref; return (await (await call('POST', '/api/households', { who: sam, body: { state: st } })).json()).id; };
    test.before(() => { ({ base, sam, chris } = ctx()); });

    test('POST /api/households/:id/exports: 200 {logged: true}; a bad kind 400; an unknown household 404; other methods 405', async () => {
      const id = await create('RC-EXP-' + crypto.randomUUID().slice(0, 6));
      let r = await call('POST', `/api/households/${id}/exports`, { who: sam, body: { kind: 'json' } });
      assert.equal(r.status, 200); assert.deepEqual(await r.json(), { logged: true });
      r = await call('POST', `/api/households/${id}/exports`, { who: sam, body: { kind: 'zip' } });
      assert.equal(r.status, 400); assert.equal((await r.json()).code, 'bad_request');
      assert.equal((await call('POST', `/api/households/${crypto.randomUUID()}/exports`, { who: sam, body: { kind: 'json' } })).status, 404);
      assert.equal((await call('POST', '/api/households/not-an-id/exports', { who: sam, body: { kind: 'json' } })).status, 404);
      assert.equal((await call('GET', `/api/households/${id}/exports`, { who: sam })).status, 405);
      assert.equal((await call('POST', `/api/households/${id}/exports`, { body: { kind: 'json' } })).status, 401, 'signed in only');
    });

    test('GET /api/households/:id/access: who read it, newest first, as {at, actor, action, outcome, detail}', async () => {
      const id = await create('RC-ACC-' + crypto.randomUUID().slice(0, 6));
      await call('GET', `/api/households/${id}`, { who: chris });
      await call('POST', `/api/households/${id}/exports`, { who: chris, body: { kind: 'excel' } });
      const r = await call('GET', `/api/households/${id}/access`, { who: sam });
      assert.equal(r.status, 200);
      const log = await r.json();
      assert.deepEqual(log.map(e => [e.actor, e.action, e.outcome, e.detail]), [['chris', 'export', 'ok', 'excel'], ['chris', 'read', 'ok', '']]);
      assert.deepEqual(keys(log[0]), ['action', 'actor', 'at', 'detail', 'outcome']);
      assert.equal((await call('GET', `/api/households/${crypto.randomUUID()}/access`, { who: sam })).status, 404);
    });

    test('retention, purge request and approval: the requester cannot approve; a second person purges; the household is then gone', async () => {
      const id = await create('RC-PRG-' + crypto.randomUUID().slice(0, 6));
      let r = await call('PUT', `/api/households/${id}/relationship`, { who: sam, body: { endedOn: 'yesterday' } });
      assert.equal(r.status, 400);
      r = await call('POST', `/api/households/${id}/purge-requests`, { who: sam, body: { reason: 'due' } });
      assert.equal(r.status, 409); assert.equal((await r.json()).code, 'relationship_open');
      r = await call('PUT', `/api/households/${id}/relationship`, { who: sam, body: { endedOn: '2015-01-10' } });
      assert.equal(r.status, 200); assert.deepEqual(await r.json(), { endedOn: '2015-01-10', retentionUntil: '2020-01-10' });
      r = await call('POST', `/api/households/${id}/purge-requests`, { who: sam, body: { reason: 'Retention ended' } });
      assert.equal(r.status, 201);
      const req = await r.json();
      assert.deepEqual(keys(req), ['counts', 'decidedAt', 'decidedBy', 'decidedById', 'householdId', 'id', 'note', 'reason', 'requestedAt', 'requestedBy', 'requestedById', 'retentionUntil', 'status']);
      assert.equal(req.status, 'pending');
      r = await call('POST', `/api/households/${id}/purge-requests`, { who: chris, body: { reason: 'again' } });
      assert.equal(r.status, 409); assert.equal((await r.json()).code, 'purge_pending');
      const ov = await (await call('GET', '/api/records', { who: chris })).json();
      assert.deepEqual(keys(ov), ['households', 'requests', 'retentionYears', 'today']);
      assert.equal(ov.retentionYears, 5);
      assert.deepEqual(keys(ov.households.find(h => h.id === id)), ['eligible', 'endedOn', 'id', 'name', 'reference', 'retentionUntil', 'stage', 'updatedAt']);
      r = await call('POST', `/api/purge-requests/${req.id}/approve`, { who: sam, body: {} });
      assert.equal(r.status, 403); assert.equal((await r.json()).code, 'same_person');
      r = await call('POST', `/api/purge-requests/${req.id}/approve`, { who: chris, body: { note: 'Checked' } });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { purged: true, householdId: id, counts: { households: 1, versions: 1, auditEntries: 2, retention: 1 } });
      assert.equal((await call('GET', `/api/households/${id}`, { who: sam })).status, 404);
      r = await call('POST', `/api/purge-requests/${req.id}/reject`, { who: sam, body: {} });
      assert.equal(r.status, 409); assert.equal((await r.json()).code, 'already_decided');
      assert.equal((await call('POST', `/api/purge-requests/${crypto.randomUUID()}/approve`, { who: chris, body: {} })).status, 404);
      assert.equal((await call('GET', `/api/purge-requests/${req.id}/approve`, { who: chris })).status, 405);
    });

    test('GET /api/households/:id/subject-access: a JSON download of everything kept, with the people to review', async () => {
      const ref = 'RC-SAR-' + crypto.randomUUID().slice(0, 6);
      const id = await create(ref);
      const r = await call('GET', `/api/households/${id}/subject-access`, { who: sam });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), new RegExp(`^attachment; filename="subject-access-${ref}-\\d{4}-\\d\\d-\\d\\d\\.json"$`));
      assert.match(r.headers.get('content-type'), /^application\/json/);
      const p = await r.json();
      assert.deepEqual(keys(p), ['accessLog', 'changeAudit', 'firmId', 'format', 'generatedAt', 'generatedBy', 'household', 'kind', 'notice', 'people', 'record', 'retention', 'versions']);
      assert.equal(p.kind, 'subject-access-export'); assert.equal(p.household.reference, ref); assert.equal(p.generatedBy, 'sam');
      assert.equal((await call('GET', `/api/households/${crypto.randomUUID()}/subject-access`, { who: sam })).status, 404);
    });
  });
}

module.exports = { recordsContract };
