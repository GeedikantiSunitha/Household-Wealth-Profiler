// frontend/src/js/services/api/client.js: the only code in the front end that calls the network.
// Run in Node with fetch stood in for: what each call sends (path, method, headers, body) and what it
// hands back, including a server that does not answer and a reply that is not JSON.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'js', 'services', 'api', 'client.js')).href);
const reply = (status, body, type = 'application/json') => ({ ok: status >= 200 && status < 300, status, headers: { get: h => (h.toLowerCase() === 'content-type' ? type : null) }, json: async () => { if (body === undefined) throw new Error('no body'); return body; } });
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, ...init }); if (answer instanceof Error) throw answer; return answer; };
  return calls;
}

test('a session write carries the CSRF token, as JSON, under api/, same-origin only', async () => {
  const { request } = await load();
  const calls = stubFetch(reply(200, { version: 2 }));
  const r = await request('PUT', 'households/x', { version: 1 }, { 'Idempotency-Key': 'k' }, { csrf: 'tok', session: true });
  assert.deepEqual(r, { ok: true, status: 200, body: { version: 2 } });
  const c = calls[0];
  assert.equal(c.url, 'api/households/x'); assert.equal(c.method, 'PUT'); assert.equal(c.credentials, 'same-origin');
  assert.deepEqual(c.headers, { Accept: 'application/json', 'Idempotency-Key': 'k', 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' });
  assert.equal(c.body, JSON.stringify({ version: 1 }));
});

test('no CSRF token on a read, nor without a session (development Basic sign-in), nor without a body type when there is no body', async () => {
  const { request } = await load();
  let calls = stubFetch(reply(200, []));
  await request('GET', 'households', undefined, undefined, { csrf: 'tok', session: true });
  assert.deepEqual(calls[0].headers, { Accept: 'application/json' }); assert.equal(calls[0].body, undefined);
  calls = stubFetch(reply(201, { id: 'a' }));
  await request('POST', 'households', { state: {} }, undefined, { csrf: 'tok', session: false });
  assert.equal(calls[0].headers['X-CSRF-Token'], undefined);
});

test('a refusal comes back as it is, for the store to decide; a reply without JSON has a null body', async () => {
  const { request } = await load();
  stubFetch(reply(409, { error: 'changed', code: 'version_conflict' }));
  assert.deepEqual(await request('PUT', 'households/x', {}, undefined, {}), { ok: false, status: 409, body: { error: 'changed', code: 'version_conflict' } });
  stubFetch(reply(502, undefined, 'text/html'));
  assert.deepEqual(await request('GET', 'me', undefined, undefined, {}), { ok: false, status: 502, body: null });
});

test('probe: the server\'s answer to api/me, status 0 when nothing answers, no body when the answer is not JSON', async () => {
  const { probe } = await load();
  const calls = stubFetch(reply(401, { code: 'sign_in_required' }));
  assert.deepEqual(await probe(), { status: 401, body: { code: 'sign_in_required' } });
  assert.equal(calls[0].url, 'api/me'); assert.equal(calls[0].credentials, 'same-origin');
  stubFetch(new TypeError('Failed to fetch'));
  assert.deepEqual(await probe(), { status: 0, body: null });
  stubFetch(reply(200, { user: 'x' }, 'text/html'));
  assert.deepEqual(await probe(), { status: 200, body: null }, 'an HTML page answering instead of the server is not a sign-in');
});

test('the split-address mode: with window.HWP_API_BASE set, every call goes to the back end\'s address and sends the session cookie; unset, nothing changes', async () => {
  const { request, probe, apiUrl, apiCredentials } = await load();
  const calls = stubFetch(reply(200, { ok: true }));
  try {
    globalThis.window = { HWP_API_BASE: 'https://api.example.com/' };
    assert.equal(apiUrl('me'), 'https://api.example.com/api/me', 'a trailing slash is dropped');
    assert.equal(apiCredentials(), 'include');
    await request('POST', 'households', { a: 1 }, undefined, { csrf: 't', session: true });
    await probe();
    assert.equal(calls[0].url, 'https://api.example.com/api/households'); assert.equal(calls[0].credentials, 'include'); assert.equal(calls[0].headers['X-CSRF-Token'], 't');
    assert.equal(calls[1].url, 'https://api.example.com/api/me'); assert.equal(calls[1].credentials, 'include');
    globalThis.window = { HWP_API_BASE: '' };
    assert.equal(apiUrl('me'), 'api/me'); assert.equal(apiCredentials(), 'same-origin');
    delete globalThis.window;
    assert.equal(apiUrl('me'), 'api/me', 'no window setting at all: one address'); assert.equal(apiCredentials(), 'same-origin');
  } finally { delete globalThis.window; }
});
