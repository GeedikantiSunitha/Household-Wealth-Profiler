/* The connection to the backend: the only place in the front end that calls the network (the
   sign-in calls go through auth.js beside this file). Nothing here decides anything: it sends a
   request and hands back { ok, status, body }; hooks/store.js decides what a reply means.
     probe()                        GET api/me without throwing: { status, body } (body null when the
                                    server did not answer, or did not answer JSON)
     request(method, path, body, extraHeaders, { csrf, session })
                                    one API call under api/; a session write carries the CSRF token */

export async function probe() {
  let body = null, status = 0;
  try {
    const r = await fetch('api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    status = r.status;
    if ((r.headers.get('content-type') || '').includes('json')) body = await r.json();
  } catch (e) { /* no answer: status 0 */ }
  return { status, body };
}

export async function request(method, path, body, extraHeaders, { csrf = '', session = false } = {}) {
  const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
  if (body) headers['Content-Type'] = 'application/json';
  if (session && csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const r = await fetch('api/' + path, { method, credentials: 'same-origin', headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
  return { ok: r.ok, status: r.status, body: j };
}

