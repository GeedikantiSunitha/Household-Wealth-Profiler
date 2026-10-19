/* The connection to the backend: the only place in the front end that calls the network (the
   sign-in calls go through auth.js beside this file). Nothing here decides anything: it sends a
   request and hands back { ok, status, body }; hooks/store.js decides what a reply means.
     apiUrl(path)                   where a call goes: api/<path> on the page's own address, or on the
                                    back end's address when window.HWP_API_BASE names one (the
                                    split-address mode, runtime-config.js)
     apiCredentials()               'same-origin' for one address; 'include' for the split mode, so the
                                    browser sends the session cookie to the back end's address
     probe()                        GET api/me without throwing: { status, body } (body null when the
                                    server did not answer, or did not answer JSON)
     request(method, path, body, extraHeaders, { csrf, session })
                                    one API call under api/; a session write carries the CSRF token */
const base = () => String((typeof window !== 'undefined' && window.HWP_API_BASE) || '').replace(/\/+$/, '');

export const apiUrl = path => (base() ? base() + '/' : '') + 'api/' + path;
export const apiCredentials = () => (base() ? 'include' : 'same-origin');

export async function probe() {
  let body = null, status = 0;
  try {
    const r = await fetch(apiUrl('me'), { credentials: apiCredentials(), headers: { Accept: 'application/json' } });
    status = r.status;
    if ((r.headers.get('content-type') || '').includes('json')) body = await r.json();
  } catch (e) { /* no answer: status 0 */ }
  return { status, body };
}

export async function request(method, path, body, extraHeaders, { csrf = '', session = false } = {}) {
  const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
  if (body) headers['Content-Type'] = 'application/json';
  if (session && csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const r = await fetch(apiUrl(path), { method, credentials: apiCredentials(), headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
  return { ok: r.ok, status: r.status, body: j };
}
