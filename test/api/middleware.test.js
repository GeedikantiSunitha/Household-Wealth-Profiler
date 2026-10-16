// backend/src/middleware: the security layer. The global gates have a fixed order, each file is
// one check, and the per-route guards (guards.js) say what one route needs beyond them. The order
// in which app.js runs the gates is pinned by test/api/app.test.js; this file pins the layer itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mw = require('../../backend/src/middleware');
const { requireStage, limited, requireRole } = require('../../backend/src/middleware/guards.js');
const { createLimiter } = require('../../backend/src/middleware/rate-limit.js');

const DIR = path.join(__dirname, '..', '..', 'backend', 'src', 'middleware');
const camel = name => name.replace(/-([a-z])/g, (m, c) => c.toUpperCase());

test('the global gates: ten, in this fixed order, one file each', () => {
  assert.deepEqual([...mw.ORDER], ['parse-url', 'health', 'api-only', 'authenticate', 'sign-in-required', 'second-step', 'firm-required', 'same-site', 'json-body', 'csrf']);
  for (const name of mw.ORDER) assert.ok(fs.existsSync(path.join(DIR, name + '.js')), `${name}.js exists`);
  const gates = mw.createGates({ send: () => {}, ready: async () => {}, serveWeb: true, basicUsers: false, authenticate: async () => null });
  for (const name of mw.ORDER) assert.equal(typeof gates[camel(name)], 'function', `gate ${name} is made`);
});

test('gates 1 to 3: a bad URL is 400 before anything; health answers before sign-in; api-only makes the screens 404', async () => {
  const sent = [];
  const send = (res, status, body) => sent.push([status, body.error]);
  const gates = mw.createGates({ send, ready: async () => {}, serveWeb: false, basicUsers: false, authenticate: async () => { throw new Error('never reached'); } });
  const bad = { req: { url: '//' }, res: {} };
  assert.equal(gates.parseUrl(bad), true); assert.deepEqual(sent.pop(), [400, 'Bad request']);
  const ok = { req: { url: '/healthz' }, res: {} };
  assert.equal(gates.parseUrl(ok), false); assert.equal(ok.p, '/healthz');
  assert.equal(await gates.health(ok), true); assert.deepEqual(sent.pop(), [200, undefined]);
  const page = { req: { url: '/index.html' }, res: {} }; gates.parseUrl(page);
  assert.equal(await gates.health(page), false);
  assert.equal(gates.apiOnly(page), true); assert.deepEqual(sent.pop(), [404, 'Not found']);
  const api = { req: { url: '/api/me' }, res: {} }; gates.parseUrl(api);
  assert.equal(gates.apiOnly(api), false, '/api/ passes the api-only gate');
});

test('gates 5 to 7: 429 locked, 401 not signed in (Basic challenge only with Basic users), 401 second step, 403 firm required', () => {
  const sent = [];
  const send = (res, status, body, headers = {}) => sent.push([status, body.code || body.error, headers]);
  const withBasic = mw.createGates({ send, basicUsers: true, authenticate: async () => null });
  const without = mw.createGates({ send, basicUsers: false, authenticate: async () => null });
  assert.equal(withBasic.signInRequired({ res: {}, auth: null }), true);
  assert.deepEqual(sent.pop(), [401, 'Sign in required', { 'WWW-Authenticate': 'Basic realm="Household Wealth Profiler", charset="UTF-8"' }]);
  assert.equal(without.signInRequired({ res: {}, auth: null }), true); assert.deepEqual(sent.pop(), [401, 'Sign in required', {}]);
  assert.equal(without.signInRequired({ res: {}, auth: { locked: true } }), true); assert.equal(sent.pop()[0], 429);
  assert.equal(without.signInRequired({ res: {}, auth: { user: 'sam' } }), false);
  assert.equal(without.secondStep({ res: {}, p: '/api/households', auth: { stage: 'password' } }), true); assert.deepEqual(sent.pop().slice(0, 2), [401, 'second_step_required']);
  assert.equal(without.secondStep({ res: {}, p: '/api/auth/totp', auth: { stage: 'password' } }), false, 'the second-step routes are allowed');
  assert.equal(without.secondStep({ res: {}, p: '/api/households', auth: { user: 'sam' } }), false, 'Basic has no stage: full');
  assert.equal(without.firmRequired({ res: {}, p: '/api/households', auth: { session: {}, firmId: null } }), true); assert.deepEqual(sent.pop().slice(0, 2), [403, 'firm_required']);
  assert.equal(without.firmRequired({ res: {}, p: '/api/me', auth: { session: {}, firmId: null } }), false, '/api/me says who you are while no firm is chosen');
  assert.equal(without.firmRequired({ res: {}, p: '/api/households', auth: { session: {}, firmId: 'f' } }), false);
});

test('gates 8 to 10 as checks: same-site, json-body and csrf each refuse exactly their case; GET passes all three', () => {
  const get = { method: 'GET', headers: {} };
  assert.equal(mw.checkSameSite(get), null); assert.equal(mw.checkJson(get), null); assert.equal(mw.checkCsrf(get, { session: {}, csrf: 'x' }), null);
  const post = headers => ({ method: 'POST', headers: { host: 'app.example', ...headers } });
  assert.equal(mw.checkSameSite(post({ origin: 'https://evil.example' }))[0], 403);
  assert.equal(mw.checkSameSite(post({ origin: 'https://app.example' })), null);
  assert.equal(mw.checkJson(post({ 'content-type': 'text/plain' }))[0], 415);
  assert.equal(mw.checkJson(post({ 'content-type': 'application/json' })), null);
  assert.equal(mw.checkCsrf(post({}), { user: 'sam' }), null, 'Basic sign-in has no session token');
  assert.equal(mw.checkCsrf(post({}), { session: {}, csrf: 'x' })[1].code, 'csrf');
  assert.equal(mw.checkCsrf(post({ 'x-csrf-token': 'x' }), { session: {}, csrf: 'x' }), null);
  assert.equal(mw.checkWrite(post({ origin: 'https://evil.example', 'content-type': 'application/json' }))[0], 403, 'same-site before json');
  assert.equal(mw.checkWrite(post({ origin: 'https://app.example' }))[0], 415);
});

test('per-route guards: requireStage none/any/full (with the CSRF token on a session write), limited per address, requireRole by the permission table', () => {
  const req = (method = 'POST', headers = {}) => ({ method, headers, socket: { remoteAddress: '10.0.0.1' } });
  assert.equal(requireStage('none')({ req: req(), auth: null }), null);
  assert.equal(requireStage('any')({ req: req(), auth: null })[1].code, 'sign_in_required');
  assert.equal(requireStage('full')({ req: req('GET'), auth: { session: {}, stage: 'password' } })[1].code, 'second_step_required');
  assert.equal(requireStage('any')({ req: req('GET'), auth: { session: {}, stage: 'password', csrf: 't' } }), null);
  assert.equal(requireStage('any')({ req: req('POST'), auth: { session: {}, stage: 'password', csrf: 't' } })[1].code, 'csrf', 'a session write needs the token at any stage');
  assert.equal(requireStage('full')({ req: req('POST', { 'x-csrf-token': 't' }), auth: { session: {}, stage: 'full', csrf: 't' } }), null);
  const limiter = createLimiter({ max: 2, windowMs: 60e3, now: () => 1000 });
  const guard = limited(limiter);
  assert.equal(guard({ req: req() }), null); assert.equal(guard({ req: req() }), null);
  const third = guard({ req: req() });
  assert.equal(third[0], 429); assert.equal(third[1].code, 'too_many_attempts'); assert.match(third[2]['Retry-After'], /^\d+$/);
  assert.equal(guard({ req: { method: 'POST', headers: {}, socket: { remoteAddress: '10.0.0.2' } } }), null, 'another address is not affected');
  assert.equal(requireRole('households.write')({ auth: { session: {}, role: 'adviser', roles: ['adviser'] } }), null);
  const refused = requireRole('households.write')({ auth: { session: {}, role: 'compliance', roles: ['compliance'] } });
  assert.equal(refused[0], 403); assert.equal(refused[1].code, 'forbidden');
  assert.equal(requireRole('households.write')({ auth: { user: 'sam' } }), null, 'Basic (development) is not restricted by role');
});
