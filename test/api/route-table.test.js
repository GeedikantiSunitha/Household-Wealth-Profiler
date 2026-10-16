// backend/src/routes/table.js: a route table maps method and path to a controller, checks ids,
// runs the route's guards in order, and either answers 405 (strict) or leaves the path to the
// next table.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouteTable } = require('../../backend/src/routes/table.js');

const ID = '00000000-0000-4000-8000-000000000001';
const sent = [];
const send = (res, status, body, headers = {}) => sent.push([status, body, headers]);
const calls = [];
const handler = name => async (req, res, ctx, params) => { calls.push([name, params, ctx.user]); send(res, 200, { name }); };
const route = createRouteTable([
  { path: '/api/x', methods: { GET: handler('list'), POST: handler('create') } },
  { path: /^\/api\/x\/([^/]+)$/, params: ['id'], ids: ['id'], guards: [ctx => (ctx.params.id === ID ? null : [403, { error: 'no', code: 'forbidden' }])], methods: { GET: handler('get') } },
  { path: /^\/api\/y\/([^/]+)\/(a|b)$/, params: ['id', 'which'], strict: true, methods: { PUT: handler('y') } },
], { send });
const req = (method, url) => ({ method, url, headers: {} });
const ctx = { user: 'sam' };

test.beforeEach(() => { sent.length = 0; calls.length = 0; });

test('a plain path: the method picks the handler; another method on it is not matched (404 comes from app.js)', async () => {
  assert.equal(await route(req('GET', '/api/x'), {}, '/api/x', ctx), true); assert.deepEqual(calls, [['list', {}, 'sam']]);
  assert.equal(await route(req('POST', '/api/x'), {}, '/api/x', ctx), true); assert.equal(calls[1][0], 'create');
  assert.equal(await route(req('DELETE', '/api/x'), {}, '/api/x', ctx), false); assert.equal(sent.length, 2);
  assert.equal(await route(req('GET', '/api/z'), {}, '/api/z', ctx), false, 'another path is for another table');
});

test('parameters come from the groups in order; an id that is not a uuid is 404 before any guard; guards run before the handler', async () => {
  assert.equal(await route(req('GET', '/api/x/nope'), {}, '/api/x/nope', ctx), true);
  assert.deepEqual(sent, [[404, { error: 'Not found' }, {}]]); assert.deepEqual(calls, []);
  const other = '00000000-0000-4000-8000-000000000002';
  assert.equal(await route(req('GET', `/api/x/${other}`), {}, `/api/x/${other}`, ctx), true);
  assert.deepEqual(sent[1], [403, { error: 'no', code: 'forbidden' }, {}]); assert.deepEqual(calls, []);
  assert.equal(await route(req('GET', `/api/x/${ID}`), {}, `/api/x/${ID}`, ctx), true);
  assert.deepEqual(calls, [['get', { id: ID }, 'sam']]);
});

test('strict: another method on a matched path is 405, and several parameters are named in order', async () => {
  assert.equal(await route(req('POST', '/api/y/7/b'), {}, '/api/y/7/b', ctx), true);
  assert.deepEqual(sent, [[405, { error: 'Method not allowed' }, {}]]);
  assert.equal(await route(req('PUT', '/api/y/7/b'), {}, '/api/y/7/b', ctx), true);
  assert.deepEqual(calls, [['y', { id: '7', which: 'b' }, 'sam']]);
});
