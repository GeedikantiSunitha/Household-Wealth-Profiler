/* Account security (the app's own sign-in): change the password, set up a new authenticator app,
   and sign out everywhere. Every call is a session write, so it carries the CSRF token (Store.api). */
import { Store } from '../hooks/store.js';
import { $, esc, toast } from '../lib/dom.js';
import { state } from '../hooks/state.js';
import { render } from './render.js';

export function renderAccount() {
  $('#main').innerHTML = `<div class="sec-head"><div><h2>Account security</h2><p>${esc(Store.name || Store.user)} · ${esc(Store.email || '')}</p></div></div>
    <div class="panel"><h3>Change your password</h3><p class="muted">At least 12 characters. Every other session of yours ends when it changes.</p>
      <form id="pwForm" novalidate><div class="fields" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
        <div class="f"><label for="pwCurrent">Current password</label><input id="pwCurrent" type="password" autocomplete="current-password" required></div>
        <div class="f"><label for="pwNext">New password</label><input id="pwNext" type="password" autocomplete="new-password" required></div>
        <div class="f"><label for="pwAgain">New password again</label><input id="pwAgain" type="password" autocomplete="new-password" required></div></div>
      <p class="gate-err" id="pwErr" role="alert"></p><div class="addrow"><button class="btn primary" type="submit">Change password</button></div></form></div>
    ${Store.totpRequired === false ? '' : `<div class="panel"><h3>Authenticator app</h3><p class="muted">Two-step verification is required at every sign-in. Setting up a new app replaces the current one and gives you new recovery codes; every other session ends.</p>
      <div class="addrow"><button class="btn" type="button" id="reenrol">Set up a new authenticator</button></div></div>`}
    <div class="panel"><h3>Sessions</h3><p class="muted">Signed in somewhere you do not recognise, or lost a device? End every session, including this one.</p>
      <div class="addrow"><button class="btn" type="button" id="signOutAll">Sign out everywhere</button></div></div>`;
  $('#pwForm').onsubmit = async e => {
    e.preventDefault();
    const current = $('#pwCurrent').value, next = $('#pwNext').value, again = $('#pwAgain').value;
    const err = $('#pwErr'); err.textContent = '';
    if (next !== again) { err.textContent = 'The two new passwords do not match.'; return; }
    try { await Store.api('POST', 'auth/password', { current, next }); toast('Password changed'); $('#pwForm').reset(); }
    catch (x) { err.textContent = x.body && x.body.code === 'bad_credentials' ? 'The current password is not right.' : x.message; }
  };
  if ($('#reenrol')) $('#reenrol').onclick = async () => {
    const { enrol } = await import('./sign-in.js');
    const r = await enrol({ withPassword: true });
    document.body.classList.remove('gated');
    if (r) { Store.csrf = r.csrf || Store.csrf; toast('New authenticator set up'); }
    state.VIEW = 'account'; render();
  };
  $('#signOutAll').onclick = async () => {
    try { await Store.api('POST', 'auth/sign-out-all', {}); } catch (x) { toast(x.message); return; }
    location.reload();
  };
}
