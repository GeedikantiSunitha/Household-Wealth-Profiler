/* The sign-in screens (Phase 2): shown instead of the app until a full session with a firm exists.
   One screen at a time, each a small form; every call goes to the sign-in API (/api/auth/).
     runGate(probe)   drives the whole flow from what /api/me answered: the landing page (Sign in, with
                      Create an account and Forgotten your password), registration and the link that
                      confirms the address, the second step (a code from the
                      authenticator app, or a recovery code), first-time enrolment (QR code and key,
                      then the recovery codes shown once), the firm picker; a #reset= or #invite=
                      link in the address opens the new-password screen first. Resolves when the
                      app can open. With TOTP_REQUIRED=0 the password alone signs in.
     firmPicker()     the firm picker on its own (switching firm from the user menu)
   Nothing here touches household data, and the screens never show the server's raw JSON. */
import { $, esc } from '../lib/dom.js';
import { authApi } from '../services/api/auth.js';

const APP_NAME = 'Household Wealth Profiler';
let pendingErr = '';
const fail = m => { pendingErr = m; };


function fieldHtml(f) {
  const id = 'g-' + f.k, max = f.max ? ' maxlength="' + f.max + '"' : '', req = f.req === false ? '' : ' required';
  const control = f.t === 'area'
    ? '<textarea id="' + id + '" name="' + f.k + '" rows="3"' + (max || ' maxlength="1000"') + req + '>' + esc(f.v || '') + '</textarea>'
    : '<input id="' + id + '" name="' + f.k + '" type="' + (f.t || 'text') + '" value="' + esc(f.v || '') + '" autocomplete="' + (f.ac || 'off') + '"' + (f.im ? ' inputmode="' + f.im + '"' : '') + max + req + '>';
  // A required field shows a red asterisk; screen readers learn it from the required attribute instead
  return '<div class="f"><label for="' + id + '">' + esc(f.l) + (req ? '<span class="req" aria-hidden="true"> *</span>' : '') + '</label>' + control + '</div>';
}
// A form; resolves with its values, or { action } for a secondary link (data-gate)
function screen({ title, intro = '', fields = [], submit = 'Continue', extra = '', before = '' }) {
  document.body.classList.add('gated');
  $('#main').innerHTML = `<form class="panel gate" id="gate" novalidate><h2>${esc(title)}</h2>${intro ? `<p class="muted">${intro}</p>` : ''}${before}
    ${fields.length ? '<div class="fields">' + fields.map(fieldHtml).join('') + '</div>' : ''}
    <p class="gate-err" id="gateErr" role="alert">${esc(pendingErr)}</p><div class="addrow">${submit ? `<button class="btn primary" type="submit">${esc(submit)}</button>` : ''}${extra}</div></form>`;
  pendingErr = '';
  const form = $('#gate');
  (form.querySelector('input[value=""]') || form.querySelector('input,textarea'))?.focus();
  return new Promise(ok => {
    form.onsubmit = e => { e.preventDefault(); ok(Object.fromEntries(new FormData(form))); };
    form.onclick = e => { const b = e.target.closest('[data-gate]'); if (b) { e.preventDefault(); ok({ action: b.dataset.gate }); } };
  });
}
const message = (title, text, next = 'signin', label = 'Back to sign in') => screen({ title, before: `<p>${text}</p>`, submit: '', extra: `<button class="btn primary" type="button" data-gate="${next}">${esc(label)}</button>${next === 'signin' ? '' : '<button class="btn ghost" type="button" data-gate="signin">Back to sign in</button>'}` });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function landing(lastEmail = '') {
  for (;;) {
    const v = await screen({ title: 'Sign in', intro: `${esc(APP_NAME)}. Client records are encrypted and every change is recorded.`,
      fields: [{ k: 'email', l: 'Email', t: 'email', ac: 'username', v: lastEmail }, { k: 'password', l: 'Password', t: 'password', ac: 'current-password' }],
      submit: 'Sign in', extra: '<button class="btn ghost" type="button" data-gate="register">Create an account</button><button class="btn ghost" type="button" data-gate="forgot">Forgotten your password?</button>' });
    if (v.action === 'register') { lastEmail = (await register()) || lastEmail; continue; }
    if (v.action === 'forgot') { await forgot(lastEmail); continue; }
    if (v.action) continue;
    lastEmail = v.email;
    try { return { ...(await authApi('POST', 'sign-in', { email: v.email, password: v.password })), email: v.email }; }
    catch (e) {
      if (e.code === 'email_unverified') { await unverified(v.email); continue; }
      fail(e.code === 'too_many_attempts' ? e.message : e.code === 'bad_credentials' ? 'Email or password is not right.' : e.message);
    }
  }
}

// Registration: a firm of their own, then a link to confirm the address, then sign in; when the server says the
// address is confirmed already (EMAIL_VERIFICATION=0), straight to sign in. Resolves with the email given (or null)
async function register() {
  for (;;) {
    const v = await screen({ title: 'Create an account', intro: 'Your firm gets its own space, with you as its administrator; you invite colleagues from the Team page.',
      fields: [{ k: 'name', l: 'Your name', max: 200 }, { k: 'email', l: 'Work email', t: 'email', ac: 'email', max: 254 }, { k: 'firm', l: 'Firm', max: 200 },
        { k: 'password', l: 'Password (at least 12 characters)', t: 'password', ac: 'new-password' }, { k: 'again', l: 'Password again', t: 'password', ac: 'new-password' }],
      submit: 'Register', extra: '<button class="btn ghost" type="button" data-gate="signin">Already registered? Sign in</button>' });
    if (v.action) return null;
    if (!v.name.trim() || !EMAIL.test(v.email.trim()) || !v.firm.trim()) { fail('Give your name, a valid email address and the name of your firm.'); continue; }
    if (v.password !== v.again) { fail('The two passwords do not match.'); continue; }
    let r;
    try { r = await authApi('POST', 'register', { name: v.name, email: v.email, firm: v.firm, password: v.password }); }
    catch (e) { fail(e.message); continue; }
    if (r && r.verified) await message('Registered', 'Your account and your firm are ready. Sign in with your email address and the password you chose.');
    else await message('Check your email', 'A link to confirm your address is on its way. It works once, for 24 hours. Open it, then sign in with your email address and the password you chose.');
    return v.email.trim();
  }
}

// Signed in with the right password, but the address is not confirmed yet
async function unverified(email) {
  const v = await message('Confirm your email address first', 'Open the link we sent you when you registered. If it has expired or did not arrive, ask for a new one.', 'resend', 'Send the link again');
  if (v.action !== 'resend') return;
  try { await authApi('POST', 'verify/resend', { email }); } catch (e) { fail(e.message); return; }
  await message('Check your email', 'If that address has an unconfirmed account, a new link is on its way. It works once, for 24 hours.');
}

// #verify=TOKEN: the address is confirmed through the link
async function verifyLink(token) {
  try { await authApi('POST', 'verify', { token }); }
  catch (e) { await message('This link is no longer valid', 'Links work once, for 24 hours. Sign in with your email and password to ask for a new one.'); return; }
  await message('Your email address is confirmed', 'Sign in with your email address and the password you chose.');
}

async function forgot(lastEmail) {
  const v = await screen({ title: 'Reset your password', intro: 'Enter your email address. If it has an account, we will send a link to choose a new password. The link works once, for 30 minutes.',
    fields: [{ k: 'email', l: 'Email', t: 'email', ac: 'username', v: lastEmail }], submit: 'Send the link', extra: '<button class="btn ghost" type="button" data-gate="signin">Back to sign in</button>' });
  if (v.action) return;
  try { await authApi('POST', 'forgot', { email: v.email }); } catch (e) { fail(e.message); return forgot(v.email); }
  await message('Check your email', 'If that address has an account, a link is on its way. It works once, for 30 minutes.');
}

// #reset=TOKEN or #invite=TOKEN: choose a password through the link
async function throughLink(kind, token) {
  for (;;) {
    const v = await screen({ title: kind === 'invite' ? 'Welcome: choose your password' : 'Choose a new password', intro: 'At least 12 characters. A sentence you will remember works well. Passwords that have appeared in a data breach are refused.',
      fields: [{ k: 'password', l: 'New password', t: 'password', ac: 'new-password' }, { k: 'again', l: 'New password again', t: 'password', ac: 'new-password' }], submit: kind === 'invite' ? 'Create my password' : 'Change my password' });
    if (v.password !== v.again) { fail('The two passwords do not match.'); continue; }
    try { await authApi('POST', kind, { token, password: v.password }); }
    catch (e) { if (e.code === 'bad_token') { await message('This link is no longer valid', kind === 'invite' ? 'Ask the operator for a new invitation.' : 'Links work once, for 30 minutes. Ask for a new one from "Forgotten your password?".'); return; } fail(e.message); continue; }
    await message(kind === 'invite' ? 'Your password is set' : 'Your password has been changed', 'Sign in with your email address and the new password.' + (kind === 'invite' ? ' You will then set up your authenticator app, which is needed at every sign-in.' : ''));
    return;
  }
}

async function totp(st) {
  for (;;) {
    const v = await screen({ title: 'Two-step verification', intro: 'Enter the 6-digit code from your authenticator app.',
      fields: [{ k: 'code', l: 'Code', ac: 'one-time-code', im: 'numeric', max: 7 }], submit: 'Verify', extra: '<button class="btn ghost" type="button" data-gate="recovery">Use a recovery code</button><button class="btn ghost" type="button" data-gate="out">Sign out</button>' });
    if (v.action === 'out') { await authApi('POST', 'sign-out', {}).catch(() => {}); return { state: 'out' }; }
    if (v.action === 'recovery') { const r = await recovery(); if (r) return r; continue; }
    try { return await authApi('POST', 'totp', { code: v.code }); }
    catch (e) { fail(e.code === 'bad_code' ? 'That code is not right. Check the time on your phone and try the next code.' : e.message); }
  }
}

async function recovery() {
  for (;;) {
    const v = await screen({ title: 'Use a recovery code', intro: 'One of the codes you saved when you set up two-step verification. It works once; afterwards you will set up a new authenticator app.',
      fields: [{ k: 'code', l: 'Recovery code', ac: 'off', max: 12 }], submit: 'Sign in', extra: '<button class="btn ghost" type="button" data-gate="back">Back</button>' });
    if (v.action) return null;
    try { return await authApi('POST', 'recovery', { code: v.code }); }
    catch (e) { fail(e.code === 'bad_code' ? 'That recovery code is not right.' : e.message); }
  }
}

let qrLib = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (qrLib) return qrLib;
  qrLib = new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'vendor/qrcode.js'; s.onload = () => window.qrcode ? ok(window.qrcode) : no(new Error('no qrcode')); s.onerror = no; document.head.appendChild(s); }).catch(() => { qrLib = null; return null; });
  return qrLib;
}
// The QR code as inline SVG from the vendored library (an empty string when it could not load: the key is shown anyway)
export async function qrSvg(uri) {
  const lib = await loadQr();
  if (!lib) return '';
  try { const q = lib(0, 'M'); q.addData(uri); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { return ''; }
}

// Enrolment: a new authenticator. withPassword: at a full session the current password is asked for first
export async function enrol({ withPassword = false } = {}) {
  let started = null;
  if (withPassword) {
    for (;;) {
      const v = await screen({ title: 'Set up a new authenticator', intro: 'Confirm your password first. Your current authenticator keeps working until the new one is confirmed.',
        fields: [{ k: 'password', l: 'Password', t: 'password', ac: 'current-password' }], submit: 'Continue', extra: '<button class="btn ghost" type="button" data-gate="back">Cancel</button>' });
      if (v.action) return null;
      try { started = await authApi('POST', 'enrol', { password: v.password }); break; } catch (e) { fail(e.code === 'bad_credentials' ? 'That password is not right.' : e.message); }
    }
  } else started = await authApi('POST', 'enrol', {});
  const svg = await qrSvg(started.uri);
  for (;;) {
    const v = await screen({ title: 'Set up two-step verification', intro: 'Client records need a second step at every sign-in. Scan this with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, Authy...), or type the key into it, then enter the code the app shows.',
      before: `<div class="gate-qr">${svg}</div><p>Key: <code data-secret="${esc(started.secret)}">${esc(started.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>`,
      fields: [{ k: 'code', l: 'Code from the app', ac: 'one-time-code', im: 'numeric', max: 7 }], submit: 'Confirm' });
    try {
      const r = await authApi('POST', 'enrol/confirm', { code: v.code });
      await screen({ title: 'Your recovery codes', intro: 'If you lose your phone, one of these codes signs you in once. Save them somewhere safe now: they are shown only this once.',
        before: `<ul class="codes">${r.recoveryCodes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`, submit: '', extra: '<button class="btn primary" type="button" data-gate="done">I have saved these codes</button>' });
      return r;
    } catch (e) { fail(e.code === 'bad_code' ? 'That code is not right. Check the time on your phone and try the next code.' : e.message); }
  }
}

// Invitations to a firm that this account has not answered: accept or decline each, before anything is chosen for the person
async function invitations() {
  for (;;) {
    const list = await authApi('GET', 'invitations');
    if (!list.length) return { stage: 'full', next: 'firm' };
    const v = await screen({ title: 'You have been invited', intro: 'Nothing is open to you in a firm until you accept its invitation.', submit: '',
      before: `<div class="firm-list">${list.map(i => `<div class="invite-row"><p><b>${esc(i.firmName)}</b> <span class="muted">as ${esc((i.roles || [i.role]).join(' + '))}</span></p>
        <button type="button" class="btn primary" data-gate="accept:${esc(i.firmId)}">Accept</button> <button type="button" class="btn" data-gate="decline:${esc(i.firmId)}">Decline</button></div>`).join('')}</div>` });
    const m = v.action && /^(accept|decline):(.+)$/.exec(v.action);
    if (!m) continue;
    try {
      const r = await authApi('POST', 'invitations/' + m[1], { firmId: m[2] });
      if (r.next === 'invitations') continue;
      if (r.next === 'none') { try { await authApi('POST', 'sign-out', {}); } catch (e) { /* already ended */ } await message('No firm to work in', 'You declined the invitation, and there is no other firm on your account. Ask your administrator if you were invited by mistake.'); return { state: 'out' }; }
      return r.stage ? r : { stage: 'full', next: r.next };
    } catch (e) { fail(e.message); }
  }
}

export async function firmPicker() {
  const firms = await authApi('GET', 'firms');
  for (;;) {
    const v = await screen({ title: 'Choose a firm', intro: 'You belong to more than one firm. Which one are you working in now?', submit: '',
      before: `<div class="firm-list">${firms.map(f => `<button type="button" class="btn" data-gate="firm:${esc(f.firmId)}">${esc(f.firmName)} <span class="muted">${esc((f.roles||[f.role]).join(' + '))}</span></button>`).join('')}</div>` });
    if (v.action && v.action.startsWith('firm:')) {
      try { return await authApi('POST', 'firm', { firmId: v.action.slice(5) }); } catch (e) { fail(e.message); }
    }
  }
}

// A reset or invitation link pasted while the sign-in page is open: start again with it
window.addEventListener('hashchange', () => { if (/^#(reset|invite|verify)=/.test(location.hash)) location.reload(); });

// probe: what /api/me answered ({ code }) or a sign-in state ({ stage, next, csrf })
export async function runGate(probe) {
  let st;
  const m = /^#(reset|invite|verify)=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (m) { history.replaceState(null, '', location.pathname + location.search); await (m[1] === 'verify' ? verifyLink(m[2]) : throughLink(m[1], m[2])); st = { state: 'out' }; }
  else if (probe.code === 'sign_in_required') st = { state: 'out' };
  else { try { st = await authApi('GET', 'state'); } catch (e) { st = { state: 'out' }; } }
  let lastEmail = '';
  for (;;) {
    if (st.state === 'out') { st = await landing(lastEmail); lastEmail = st.email || lastEmail; }
    else if (st.stage === 'password' && st.next === 'enrol') st = await enrol();
    else if (st.stage === 'password') st = await totp(st);
    else if (st.stage === 'full' && st.next === 'enrol') st = (await enrol({ withPassword: true })) || { state: 'out' };
    else if (st.stage === 'full' && st.next === 'invitations') st = await invitations();
    else if (st.stage === 'full' && st.next === 'firm') st = await firmPicker();
    else { document.body.classList.remove('gated'); $('#main').innerHTML = ''; return st; }
  }
}
