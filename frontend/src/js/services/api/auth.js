/* The sign-in API (/api/auth/), for pages/sign-in.js. Keeps the session's CSRF token from the last
   reply and sends it with every write, so a half-finished sign-in (second step, firm choice) can
   carry on. Resolves with the reply; rejects with an error carrying status and code. */
let csrf = '';

export async function authApi(method, path, body) {
  const r = await fetch('api/auth/' + path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) { const err = new Error((j && j.error) || 'The server did not answer. Try again.'); err.status = r.status; err.code = j && j.code; throw err; }
  if (j && j.csrf) csrf = j.csrf;
  return j;
}
