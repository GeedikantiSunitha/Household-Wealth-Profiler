#!/usr/bin/env node
// Screen check: runs the real app and drives headless Chrome through every screen, the way an
// adviser would. Saves a full-page screenshot of each screen and fails on any script error, a
// screen that does not render, an autosave that does not finish, data lost on reload, or a
// missing edit-conflict warning. Uses only Node and an installed Chrome (no packages).
//
//   npm run screens                 screenshots in docs/checklists/screens/<date-time>/
//   npm run screens -- baseline     screenshots in docs/checklists/screens/baseline/
//   CHROME=/path/to/chrome npm run screens
//
// The app runs on a temporary data folder with a demo login, never on data-dev or a database.
// The browser clock is fixed at 2026-10-10 so the sample household's dates, and so the
// screenshots, are the same on every run. Compare a run with baseline by eye (docs/checklists/screen-smoke.md).
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

// HWP_SCREENS_ROOT runs the same check against another copy of the app (for example a release being
// compared with this one); by default it is this project.
const ROOT = process.env.HWP_SCREENS_ROOT ? path.resolve(process.env.HWP_SCREENS_ROOT) : path.join(__dirname, '..', '..');
const LABEL = process.argv[2] || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const OUT = path.join(ROOT, 'docs', 'checklists', 'screens', LABEL);
const FROZEN = '2026-10-10T10:00:00Z';
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));
// The side rail: six collapsible groups and their sections, in order. A change here is a change to
// the app's navigation.
const GROUPS = [
  ['client', ['household', 'members', 'income', 'expenses', 'goals', 'assumptions']],
  ['wealth', ['accounts', 'db', 'property', 'other', 'liabilities', 'protection']],
  ['onboarding', ['compliance', 'rtq', 'kyc', 'audit']],
  ['relationship', ['contacts', 'actions', 'loas', 'complaints', 'reviews']],
  ['mandate', ['mandate', 'models', 'drift', 'perf']],
  ['analysis', ['bs', 'scenarios', 'tax', 'risk', 'checks', 'guide']],
];
const NAV = GROUPS.flatMap(([, ids]) => ids);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((ok, fail) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); s.on('error', fail); });
async function waitHttp(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.ok) return r; } catch (e) {} await sleep(150); }
  throw new Error('No answer from ' + url);
}

/* Minimal Chrome DevTools Protocol client over Node's built-in WebSocket */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const waiting = new Map(); const handlers = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const { ok, fail } = waiting.get(m.id); waiting.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); }
    else if (m.method) for (const h of handlers) h(m.method, m.params);
  };
  return new Promise((ok, fail) => {
    ws.onerror = () => fail(new Error('Could not connect to Chrome'));
    ws.onopen = () => ok({
      send: (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { ok: res, fail: rej }); ws.send(JSON.stringify({ id, method, params })); }),
      on: h => handlers.push(h),
      close: () => ws.close(),
    });
  });
}

const results = []; const problems = [];
const pass = msg => { results.push('PASS  ' + msg); console.log('  ✔ ' + msg); };
const fail = msg => { results.push('FAIL  ' + msg); problems.push(msg); console.log('  ✖ ' + msg); };

(async () => {
  if (!CHROME) throw new Error('Chrome or Edge not found. Set CHROME to its path.');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-screens-data-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-screens-chrome-'));
  const appPort = await freePort(), debugPort = await freePort();
  const BASE = `http://127.0.0.1:${appPort}/`;
  let app, chrome, page;
  try {
    const demo = execFileSync(process.execPath, ['server.js', 'hash-password', 'demo', 'demo'], { cwd: ROOT }).toString().trim();
    app = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1',
      DATA_DIR: data, DATABASE_URL: '', DATABASE_OWNER_URL: '', SMTP_URL: '', SMTP_FROM: '', OPERATOR_EMAIL: '', PUBLIC_URL: '', DATA_KEY: '', ALLOW_PLAINTEXT: '1', HSTS: '0', AUTH_USERS: demo } });
    await waitHttp(BASE + 'healthz');
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
      `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' });
    await waitHttp(`http://127.0.0.1:${debugPort}/json/version`);
    const target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page');
    page = await cdp(target.webSocketDebuggerUrl);

    // Script errors anywhere fail the run, except the 409 in the conflict step (expect409) and the
    // failed start-up call in the "server unreachable" steps (breakMe: { how, url }; 'down' fails
    // the call, 'html' answers a non-JSON page).
    let expect409 = false, breakMe = null; let expect400 = false, expectAuth = false;
    page.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') problems.push('Script error: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
      if (method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push('console.error: ' + p.args.map(a => a.value ?? a.description).join(' '));
      if (method === 'Log.entryAdded' && p.entry.level === 'error' && !(expect409 && /status of 409/.test(p.entry.text)) && !(expect400 && /status of 400/.test(p.entry.text)) && !(expectAuth && /status of (401|403|429)/.test(p.entry.text)) && !(breakMe && breakMe.url.test(p.entry.url || ''))) problems.push('Browser error: ' + p.entry.text + ' ' + (p.entry.url || ''));
    });
    for (const d of ['Page', 'Runtime', 'Log']) await page.send(d + '.enable');
    // Sign in as a browser does: the Basic header goes to the app's own address only
    const AUTH = 'Basic ' + Buffer.from('demo:demo').toString('base64');
    page.on((method, p) => {
      if (method !== 'Fetch.requestPaused') return;
      if (breakMe && breakMe.url.test(p.request.url)) {
        if (breakMe.how === 'down') page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionFailed' }).catch(() => {});
        else page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<html>proxy error</html>').toString('base64') }).catch(() => {});
        return;
      }
      const headers = Object.entries(p.request.headers).map(([name, value]) => ({ name, value })).concat({ name: 'Authorization', value: AUTH });
      page.send('Fetch.continueRequest', { requestId: p.requestId, headers }).catch(() => {});
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: BASE + '*', requestStage: 'Request' }] });
    // Steady screenshots: the app's CSS turns its fades off for reduced motion
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const Real = Date, FIXED = Real.parse('${FROZEN}');
      class FrozenDate extends Real { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } }
      globalThis.Date = FrozenDate; })();` });

    const js = async expr => { const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    const until = async (expr, what, ms = 8000) => { const end = Date.now() + ms;
      while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(100); }
      throw new Error('Timed out waiting for ' + what); };
    const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('No element ${sel.replace(/'/g, '')}'); el.click(); return true; })()`);
    // Opens a section from the side rail, first opening its group when that is collapsed
    const nav = async id => {
      const [g] = GROUPS.find(([, ids]) => ids.includes(id));
      if (!(await js(`!!document.querySelector('[data-nav="${id}"]')`))) await click(`[data-act="navGroup"][data-g="${g}"]`);
      await click(`[data-nav="${id}"]`);
    };
    const type = (sel, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() || ''`);
    // 30 s: a cold Chrome also fetches the Google fonts before the page counts as loaded
    const go = async () => { await page.send('Page.navigate', { url: BASE }); await until(`document.readyState === 'complete' && !!document.querySelector('#main h2')`, 'the app to start', 30000); };
    fs.mkdirSync(OUT, { recursive: true });
    let n = 0;
    async function shot(name, width = 1366) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      await js('document.fonts.ready.then(() => true)');
      // Pop-up messages ("Loaded the latest version") fade after 2.8 s; wait so they never land in a shot
      await until(`document.querySelector('#toast').hidden`, 'the pop-up message to close', 6000);
      await sleep(250);
      const h =Math.min(await js('Math.ceil(document.documentElement.scrollHeight)'), 16000);
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: width < 600 });
      await sleep(150);
      const { data: png } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = `${String(++n).padStart(2, '0')}-${name}.png`;
      fs.writeFileSync(path.join(OUT, file), Buffer.from(png, 'base64'));
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
      return file;
    }
    const step = async (msg, fn) => { const before = problems.length; try { await fn(); problems.length === before ? pass(msg) : fail(msg + ' (' + problems.slice(before).join('; ') + ')'); } catch (e) { fail(msg + ': ' + e.message); } };

    console.log(`Screens → ${path.relative(ROOT, OUT)}`);
    await step('sign in opens the client list (empty)', async () => {
      await go();
      if (await text('#main h2') !== 'Households') throw new Error('first screen is ' + await text('#main h2'));
      await until(`/No households yet/.test(document.querySelector('#main').textContent)`, 'the empty list');
      if (!/Signed in as/.test(await text('#who'))) throw new Error('no signed-in name');
      await shot('clients-empty');
    });
    await step('"New from sample" creates the Harrington household', async () => {
      await click('[data-act="newSample"]');
      await until(`/Harrington household/.test(document.querySelector('#hhName').textContent)`, 'the new household');
    });
    await step(`the side rail has ${GROUPS.length} groups; opened, they list the ${NAV.length} sections in order`, async () => {
      const groups = await js(`[...document.querySelectorAll('[data-act="navGroup"]')].map(b => b.dataset.g)`);
      if (JSON.stringify(groups) !== JSON.stringify(GROUPS.map(([g]) => g))) throw new Error('groups: ' + groups.join(','));
      for (const [g] of GROUPS) if (await js(`document.querySelector('[data-act="navGroup"][data-g="${g}"]').getAttribute('aria-expanded')`) !== 'true') await click(`[data-act="navGroup"][data-g="${g}"]`);
      const ids = await js(`[...document.querySelectorAll('[data-nav]')].map(b => b.dataset.nav)`);
      if (JSON.stringify(ids) !== JSON.stringify(NAV)) throw new Error('got ' + ids.join(','));
      await shot('rail-open');
    });
    await step('the header and rail show what core.js works out (KYC and AML, 2 open)', async () => {
      if (!/KYC and AML/.test(await text('#hhName'))) throw new Error('header: ' + await text('#hhName'));
      const kyc = await text('[data-nav="kyc"] .ct');
      if (kyc !== '2 open') throw new Error('KYC count: ' + kyc);
    });
    for (const id of NAV) {
      await step(`section renders: ${id}`, async () => {
        await nav(id);
        await until(`document.querySelector('[data-nav="${id}"]').getAttribute('aria-current') === 'true' && document.querySelector('#main').children.length > 0`, id);
        if (id === 'audit') await until(`!/Loading/.test(document.querySelector('#main').textContent)`, 'the audit trail');
        if (/Something went wrong|undefined|NaN/.test(await text('#main'))) throw new Error('suspicious text on screen');
        await shot(id);
      });
    }
    await step('typing a change is picked up, then autosaved ("Unsaved changes", then "All changes saved")', async () => {
      await nav('household');
      await until(`!!document.querySelector('#f-household-0-reference')`, 'the reference field');
      await type('#f-household-0-reference', 'HH-SCREEN');
      // A freshly opened household already says "All changes saved", so first prove the typing registered
      await until(`document.querySelector('#saveState').textContent === 'Unsaved changes'`, 'the edit to be picked up', 3000);
      await until(`/Client reference/.test(document.querySelector('#impactWhy')?.textContent || '')`, 'the live-effect panel to note the edit', 3000);
      await until(`document.querySelector('#saveState').textContent === 'All changes saved'`, 'autosave', 10000);
    });
    await step('after a reload the change is still there', async () => {
      await go();
      await until(`/HH-SCREEN/.test(document.querySelector('#main').textContent)`, 'the saved reference in the client list');
      await shot('clients-one-household');
      await click('[data-act="openHousehold"]');
      await until(`/Harrington household/.test(document.querySelector('#hhName').textContent)`, 'the household to open');
      await nav('household');
      await until(`document.querySelector('#f-household-0-reference')?.value === 'HH-SCREEN'`, 'the saved value in the form');
    });
    await step('"Reviews due" across households renders', async () => {
      await click('#btnClients');
      await until(`document.querySelector('#main h2')?.textContent === 'Households'`, 'the client list');
      await click('[data-act="diary"]');
      await until(`document.querySelector('#main h2')?.textContent === 'Reviews due' && !/Loading/.test(document.querySelector('#main').textContent)`, 'the diary');
      await shot('diary');
    });
    await step('"Tasks" and "Firm settings" across the firm render', async () => {
      await click('[data-act="tasks"]');
      await until(`document.querySelector('[data-act="tasks"]').getAttribute('aria-current') === 'true' && document.querySelector('#main').children.length > 0`, 'the tasks board');
      if (/Something went wrong|undefined|NaN/.test(await text('#main'))) throw new Error('suspicious text on the tasks board');
      await shot('tasks');
      await click('[data-act="firmSettings"]');
      await until(`document.querySelector('[data-act="firmSettings"]').getAttribute('aria-current') === 'true' && document.querySelector('#main').children.length > 0`, 'firm settings');
      if (/Something went wrong|undefined|NaN/.test(await text('#main'))) throw new Error('suspicious text in firm settings');
      await shot('firm-settings');
    });
    await step('a save after someone else\'s save shows the conflict warning', async () => {
      await click('[data-act="goClients"]');
      await until(`!!document.querySelector('[data-act="openHousehold"]')`, 'the client list');
      await click('[data-act="openHousehold"]');
      await until(`/Harrington household/.test(document.querySelector('#hhName').textContent)`, 'the household');
      await nav('household');
      await until(`!!document.querySelector('#f-household-0-reference')`, 'the form');
      // Another adviser saves first, straight through the API
      await js(`(async () => { const [h] = await (await fetch('api/households')).json(); const rec = await (await fetch('api/households/' + h.id)).json();
        rec.state.household.reference = 'HH-OTHER';
        const r = await fetch('api/households/' + h.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: rec.version, state: rec.state }) });
        if (!r.ok) throw new Error('other save failed ' + r.status); return true; })()`);
      expect409 = true;
      await type('#f-household-0-reference', 'HH-MINE');
      await until(`/Someone else saved this household/.test(document.body.textContent)`, 'the conflict banner', 10000);
      expect409 = false;
      if (await text('#saveState') !== 'Not saved: newer version exists') throw new Error('save state: ' + await text('#saveState'));
      await shot('conflict-warning');
      await click('[data-act="reloadHousehold"]');
      await until(`document.querySelector('#f-household-0-reference')?.value === 'HH-OTHER'`, 'their version to load');
    });
    await step('top-bar Export JSON saves the open household (the toolbar is wired)', async () => {
      await click('#btnJson');
      await until(`/^Downloaded .+-profile\\.json$/.test(document.querySelector('#toast').textContent)`, 'the download message', 5000);
    });
    await step('phone width (390 px): household, balance sheet, KYC', async () => {
      for (const id of ['household', 'bs', 'kyc']) {
        await nav(id);
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
        await sleep(250);
        // Recorded, not judged: today's layout is the baseline to compare against
        results.push(`INFO  ${id} at 390 px: page is ${await js('document.documentElement.scrollWidth')} px wide`);
        await shot(id + '-phone', 390);
      }
    });
    // Data entered while served by the server must never fall back to this browser's storage
    await step('a double-click on "New household" creates one household, not two', async () => {
      await click('#btnClients');
      await until(`document.querySelector('#main h2')?.textContent === 'Households' && !!document.querySelector('.clients')`, 'the client list');
      const before = await js(`document.querySelectorAll('.clients tbody tr').length`);
      await js(`(() => { const b = document.querySelector('[data-act="newBlank"]'); b.click(); b.click(); return true; })()`);
      await until(`document.querySelector('[data-nav="household"]')?.getAttribute('aria-current') === 'true'`, 'the new household');
      await click('#btnClients');
      await until(`document.querySelectorAll('.clients tbody tr').length > ${before}`, 'the list to grow');
      const after = await js(`document.querySelectorAll('.clients tbody tr').length`);
      if (after !== before + 1) throw new Error(`${after - before} households were created`);
    });
    // The server refuses a save by code; the app names what to change, not the conflict warning, and retries on the next edit
    await step('a save refused as a duplicate client reference says so (not the conflict warning) and goes through once the reference is changed', async () => {
      await click('[data-act="openHousehold"]'); // the newest household: the blank one just created
      await until(`!!document.querySelector('#hhName') && !document.querySelector('.clients')`, 'the household');
      await nav('household');
      await until(`!!document.querySelector('#f-household-0-reference')`, 'the form');
      expect409 = true;
      await type('#f-household-0-reference', 'HH-OTHER'); // the Harrington household's reference
      await until(`/another household in this firm already uses this client reference/.test(document.body.textContent)`, 'the duplicate-reference banner', 10000);
      expect409 = false;
      if (/Someone else saved this household/.test(await text('body'))) throw new Error('the conflict warning was shown for a duplicate reference');
      if (await text('#saveState') !== 'Not saved: client reference already in use') throw new Error('save state: ' + await text('#saveState'));
      await shot('duplicate-reference');
      await type('#f-household-0-reference', 'HH-UNIQUE');
      await until(`document.querySelector('#saveState').textContent === 'All changes saved'`, 'the save after the correction', 10000);
      if (/already uses this client reference/.test(await text('body'))) throw new Error('the banner stayed after the save went through');
    });
    await step('a value outside the field rules is refused with the screen and field named (never the value), and saved once corrected', async () => {
      expect400 = true;
      await type('#f-household-0-giftsLast7', '10000000000000');
      await until(`/Not saved: some values are outside the rules/.test(document.body.textContent)`, 'the refusal banner', 10000);
      expect400 = false;
      const banner = await text('.banner.bad');
      if (!/Household, Gifts in last 7 years \(£\): must be between -1,000,000,000,000 and 1,000,000,000,000/.test(banner)) throw new Error('the problem is not named: ' + banner);
      if (/10000000000000/.test(banner)) throw new Error('the banner echoes the submitted value');
      if (await text('#saveState') !== 'Not saved: see the message above') throw new Error('save state: ' + await text('#saveState'));
      await shot('refused-value');
      await type('#f-household-0-giftsLast7', '1000');
      await until(`document.querySelector('#saveState').textContent === 'All changes saved'`, 'the save after the correction', 10000);
      if (/outside the rules/.test(await text('body'))) throw new Error('the banner stayed after the save went through');
    });
    for (const [how, url, label, message] of [
      ['down', /\/api\/me$/, 'the server is unreachable', /The server could not be reached, so nothing you enter would be saved/],
      ['html', /\/api\/me$/, 'something other than the server answers', /The server could not be reached, so nothing you enter would be saved/],
      ['down', /\/api\/firm$/, 'the firm settings cannot be loaded', /The firm settings could not be loaded from the server/],
    ]) {
      await step(`when ${label} at start-up: an error, and no browser-only saving`, async () => {
        breakMe = { how, url };
        await page.send('Page.navigate', { url: BASE });
        await until(`document.readyState === 'complete' && /Cannot open the profiler/.test(document.querySelector('#main').textContent)`, 'the error', 30000);
        if (!message.test(await text('#main'))) throw new Error('message: ' + await text('#main'));
        if (await text('#saveState') === 'Saved in this browser only') throw new Error('fell back to browser-only saving');
        if (await js(`!!document.querySelector('[data-k]')`)) throw new Error('a data-entry field is on screen');
        breakMe = null;
      });
    }
    // ---- The app's own sign-in (session mode), against a scratch PostgreSQL database when TEST_DATABASE_URL is set
    const DB = process.env.TEST_DATABASE_URL;
    if (DB) {
      const { codeAt, base32Decode } = require('../../apps/api/src/auth/totp.js');
      const port2 = await freePort(); const BASE2 = `http://127.0.0.1:${port2}/`;
      const key = execFileSync(process.execPath, ['server.js', 'gen-key'], { cwd: ROOT }).toString().trim();
      const env2 = { ...process.env, PORT: String(port2), HOST: '127.0.0.1', DATABASE_URL: DB, DATABASE_OWNER_URL: DB, DATA_KEY: key, AUTH_USERS: '', ALPHAVANTAGE_KEY: '', HSTS: '0', SMTP_URL: '', OPERATOR_EMAIL: 'operator@example.com', PUBLIC_URL: BASE2.replace(/\/$/, '') };
      execFileSync(process.execPath, ['server.js', 'migrate'], { cwd: ROOT, env: env2 });
      execFileSync(process.execPath, ['server.js', 'create-user', 'ava@example.com', 'Ava Adviser'], { cwd: ROOT, env: env2 });
      execFileSync(process.execPath, ['server.js', 'set-password', 'ava@example.com'], { cwd: ROOT, env: env2, input: 'correct horse battery staple\n' });
      let log2 = '';
      const app2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: env2 });
      app2.stdout.on('data', d => { log2 += d; }); app2.stderr.on('data', d => { log2 += d; });
      expectAuth = true;
      try {
        await waitHttp(BASE2 + 'healthz');
        const go2 = async (hash = '') => { await page.send('Page.navigate', { url: BASE2 + hash }); await until(`document.readyState === 'complete' && !!document.querySelector('#gate, #main h2')`, 'the app', 30000); };
        const fill = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('No field ' + ${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        const submit = () => js(`(() => { document.querySelector('#gate button[type=submit]').click(); return true; })()`);
        const heading = () => js(`document.querySelector('#gate h2')?.textContent || document.querySelector('#main h2')?.textContent || ''`);
        let secret, usedStep = 0;
        const nextCode = () => { const now = Math.floor(Date.now() / 30000); const step = now > usedStep ? now : usedStep + 1; usedStep = step; return codeAt(base32Decode(secret), step); };
        await step('sign-in page: Sign in and Request access, no data on screen, no Basic prompt', async () => {
          await go2();
          await until(`!!document.querySelector('#gate')`, 'the sign-in form');
          if (await heading() !== 'Sign in') throw new Error('heading: ' + await heading());
          if (await js(`!!document.querySelector('[data-k]')`)) throw new Error('a data field is on screen');
          await shot('signin');
        });
        await step('Request access: the form is stored and acknowledged; the operator is told', async () => {
          await click('[data-gate="request"]');
          await until(`document.querySelector('#gate h2')?.textContent === 'Request access'`, 'the request form');
          await fill('#g-name', 'New Adviser'); await fill('#g-email', 'new@example.com'); await fill('#g-firm', 'Alder Wealth'); await fill('#g-note', 'I work with Ava');
          await shot('request-access');
          await submit();
          await until(`/Thank you/.test(document.querySelector('#gate')?.textContent || '')`, 'the acknowledgement', 10000);
          if (!/Access request from New Adviser/.test(log2)) throw new Error('the operator was not told (log fallback)');
          await click('[data-gate="signin"]');
          await until(`document.querySelector('#gate h2')?.textContent === 'Sign in'`, 'back to sign in');
        });
        await step('first sign-in: password, then the authenticator is set up (QR code and key) and confirmed with a code; recovery codes shown once; the client list', async () => {
          await fill('#g-email', 'ava@example.com'); await fill('#g-password', 'correct horse battery staple'); await submit();
          await until(`document.querySelector('#gate h2')?.textContent === 'Set up two-step verification'`, 'the enrolment screen', 15000);
          await until(`!!document.querySelector('.gate-qr svg') && !!document.querySelector('[data-secret]')`, 'the QR code and key', 10000);
          secret = await js(`document.querySelector('[data-secret]').dataset.secret`);
          await shot('enrol');
          await fill('#g-code', nextCode()); await submit();
          await until(`document.querySelector('#gate h2')?.textContent === 'Your recovery codes'`, 'the recovery codes', 15000);
          const codes = await js(`[...document.querySelectorAll('.codes li')].map(l => l.textContent)`);
          if (codes.length !== 10) throw new Error('codes shown: ' + codes.length);
          await shot('recovery-codes');
          await click('[data-gate="done"]');
          await until(`document.querySelector('#main h2')?.textContent === 'Households'`, 'the client list', 15000);
          if (!/Ava Adviser/.test(await text('#who'))) throw new Error('top bar: ' + await text('#who'));
          await shot('session-clients');
        });
        await step('the user menu: account security (change password, new authenticator, sign out everywhere); sign out returns to the sign-in page', async () => {
          await click('#who summary');
          await shot('user-menu');
          await click('[data-act="account"]');
          await until(`document.querySelector('#main h2')?.textContent === 'Account security'`, 'the account page');
          await shot('account-security');
          await click('#who summary'); await click('[data-act="signOut"]');
          await until(`document.querySelector('#gate h2')?.textContent === 'Sign in'`, 'the sign-in page', 15000);
        });
        await step('forgotten password: the link (from the log here) opens the new-password screen; the new password and a code sign in', async () => {
          await click('[data-gate="forgot"]');
          await until(`document.querySelector('#gate h2')?.textContent === 'Reset your password'`, 'the reset form');
          await fill('#g-email', 'ava@example.com'); await submit();
          await until(`/If that address has an account/.test(document.querySelector('#gate')?.textContent || '')`, 'the acknowledgement', 10000);
          const m = /#reset=([A-Za-z0-9_-]{43})/.exec(log2); if (!m) throw new Error('no reset link in the server log');
          await page.send('Page.navigate', { url: 'about:blank' }); // as from an email: a fresh navigation, not a fragment change
          await go2('#reset=' + m[1]);
          await until(`document.querySelector('#gate h2')?.textContent === 'Choose a new password'`, 'the new-password screen');
          await shot('new-password');
          await fill('#g-password', 'a wholly new passphrase 1'); await fill('#g-again', 'a wholly new passphrase 1'); await submit();
          await until(`/Your password has been changed/.test(document.querySelector('#gate')?.textContent || '')`, 'the confirmation', 10000);
          await click('[data-gate="signin"]');
          await until(`document.querySelector('#gate h2')?.textContent === 'Sign in'`, 'the sign-in form');
          await fill('#g-email', 'ava@example.com'); await fill('#g-password', 'a wholly new passphrase 1'); await submit();
          await until(`document.querySelector('#gate h2')?.textContent === 'Two-step verification'`, 'the code screen', 15000);
          await shot('totp');
          await fill('#g-code', nextCode()); await submit();
          await until(`document.querySelector('#main h2')?.textContent === 'Households'`, 'the client list', 15000);
        });
        await step('records and retention (Phase 4): hidden from an adviser; a compliance user ends a relationship, requests a purge, and cannot approve it alone', async () => {
          if (await js(`!!document.querySelector('[data-act="records"]')`)) throw new Error('an adviser sees Records and retention');
          await click('[data-act="newBlank"]');
          await until(`document.querySelector('#main h2') && document.querySelector('#main h2').textContent !== 'Households'`, 'the new household', 15000);
          execFileSync(process.execPath, ['server.js', 'create-user', 'ava@example.com', 'Ava Adviser', 'f1a00000-0000-4000-8000-000000000001', 'compliance'], { cwd: ROOT, env: env2 });
          await go2();
          await until(`!!document.querySelector('[data-act="records"]')`, 'the Records and retention entry for a compliance user', 15000);
          await click('[data-act="records"]');
          await until(`document.querySelector('#main h2')?.textContent === 'Records and retention' && !!document.querySelector('[data-rec="end"]')`, 'the records page', 15000);
          await shot('records');
          await js(`(() => { const el = document.querySelector('input[type=date][id^="end-"]'); el.value = '2015-01-10'; return true; })()`);
          await click('[data-rec="end"]');
          await until(`!!document.querySelector('[data-rec="request"]')`, 'the purge request form (retention ended 2020-01-10)', 15000);
          await fill('[id^="why-"]', 'Retention period over');
          await click('[data-rec="request"]');
          await until(`/Your request: someone else must approve/.test(document.querySelector('#main').textContent)`, 'the waiting request, with no approve button for the requester', 15000);
          if (await js(`!!document.querySelector('[data-rec="ask"], [data-rec="approve"]')`)) throw new Error('the requester is offered approval');
          await shot('records-requested');
          await click('[data-rec="log"]');
          await until(`/Hide access log/.test(document.querySelector('#main').textContent)`, 'the access log', 15000);
        });
        // ---- Roles (Phase 3): the same app, signed in as each role. Sessions are issued straight into the scratch database
        // (the sign-in itself is covered above); what is checked here is what each role is shown and allowed to do, a sign-off
        // that fills in its own reviewer and goes stale, several roles on one membership, and an invitation answered at sign-in.
        await step('roles: an administrator, an adviser and a compliance reviewer each see only what their role allows', async () => {
          const H = require('../../packages/core/core.js');
          const { createAuthStore } = require('../../apps/api/src/auth/store.js');
          const { createSessions, sessionSecretFrom } = require('../../apps/api/src/auth/sessions.js');
          const FIRM = 'f1a00000-0000-4000-8000-000000000001';
          const pool = new (require('pg').Pool)({ connectionString: DB });
          const cli = (...args) => execFileSync(process.execPath, ['server.js', ...args], { cwd: ROOT, env: env2, stdio: 'pipe' }).toString();
          try {
            const sess2 = createSessions({ store: createAuthStore({ pool }), secret: sessionSecretFrom(Buffer.from(key, 'base64')), secure: false });
            // more seats for the invitations below, and a second firm where one person already has an account
            cli('firm-seats', FIRM, '8');
            const OTHER = /Firm created: ([0-9a-f-]{36})/.exec(cli('firm-create', 'Other firm', '3'))[1];
            const uid = {};
            for (const [email, name, role, firm] of [['dana@example.com', 'Dana Admin', 'admin', FIRM], ['sam@example.com', 'Sam Adviser', 'adviser', FIRM], ['casey@example.com', 'Casey Compliance', 'compliance', FIRM], ['ned@example.com', 'Ned Other', 'admin', OTHER]]) {
              cli('create-user', email, name, firm, role);
              uid[email] = (await pool.query('select id from users where email = $1', [email])).rows[0].id;
            }
            // One household to work on, made by the administrator through the API (so she is one of the people who worked on it)
            const adm = await sess2.issue({ userId: uid['dana@example.com'], firmId: FIRM, stage: 'full' });
            const st = H.sample(); st.isSample = false; st.household.reference = 'ROLE-1';
            Object.assign(st.compliance, { preparer: 'Sam Adviser', reviewer: '', reviewDate: '', outcome: 'pending', reviewNotes: '' });
            const made = await fetch(BASE2 + 'api/households', { method: 'POST', headers: { Cookie: 'hwp_session=' + adm.id, 'Content-Type': 'application/json', 'X-CSRF-Token': adm.csrf }, body: JSON.stringify({ state: st }) });
            if (made.status !== 201) throw new Error('could not make the household: ' + made.status);

            const cookieFor = async (email, firm) => {
              const sess = await sess2.issue({ userId: uid[email], firmId: firm, stage: 'full' });
              await page.send('Network.enable'); await page.send('Network.clearBrowserCookies');
              await page.send('Network.setCookie', { name: 'hwp_session', value: sess.id, url: BASE2, httpOnly: true, sameSite: 'Strict' });
            };
            const signInAs = async email => { await cookieFor(email, FIRM); await go2(); await until(`document.querySelector('#main h2')?.textContent === 'Households'`, 'the client list', 15000); };
            const enabled = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('No field ' + ${JSON.stringify(sel)}); return !e.disabled; })()`);
            const present = sel => js(`!!document.querySelector(${JSON.stringify(sel)})`);
            const expectTrue = async (ok, what) => { if (!(await ok)) throw new Error(what); };
            const rowOfRole1 = `[...document.querySelectorAll('[data-act="openHousehold"]')].find(b => /ROLE-1/.test((b.closest('tr') || b).textContent))`;
            const openHousehold = async () => { await until(`!!${rowOfRole1}`, 'the ROLE-1 household in the list', 10000); await js(`(() => { ${rowOfRole1}.click(); return true; })()`); await until(`/ROLE-1/.test(document.querySelector('#hhName').textContent)`, 'the household to open'); };
            const saved = () => until(`document.querySelector('#saveState').textContent === 'All changes saved'`, 'the change to save', 10000);
            const addHidden = `!document.querySelector('[data-act="add"]') || getComputedStyle(document.querySelector('[data-act="add"]')).display === 'none'`;
            const compliance = async () => { await nav('compliance'); await until(`!!document.querySelector('#f-compliance-0-reviewer')`, 'the sign-off fields'); };

            // -- a compliance reviewer: reads everything, signs off as themselves (not typed), changes nothing else
            await signInAs('casey@example.com');
            await expectTrue(js(`!document.querySelector('[data-act="newBlank"]')`), 'a compliance reviewer is offered "New household"');
            await expectTrue(js(`/Compliance reviewer/.test(document.querySelector('#who').textContent)`), 'the role is not shown in the top bar');
            await openHousehold();
            await expectTrue(js(`document.querySelector('#btnImport').hidden`), 'Import is offered to a reviewer');
            await nav('household'); await until(`!!document.querySelector('#f-household-0-reference')`, 'the reference field');
            await expectTrue(js(`document.querySelector('#f-household-0-reference').disabled`), 'a household field is open to a reviewer');
            await expectTrue(js(`document.querySelector('#main').classList.contains('ro') && /You can read this file/.test(document.querySelector('.lock-note')?.textContent || '')`), 'no read-only note');
            await nav('members'); await until(`!!document.querySelector('[data-act="toggleAll"]')`, 'the People screen');
            await expectTrue(js(addHidden), 'Add is offered to a reviewer');
            await compliance();
            for (const k of ['outcome', 'reviewNotes']) await expectTrue(enabled(`#f-compliance-0-${k}`), `sign-off field ${k} is locked for a reviewer`);
            for (const k of ['reviewer', 'reviewDate', 'serviceType', 'preparer', 'termsDate']) await expectTrue(js(`document.querySelector('#f-compliance-0-${k}').disabled`), `field ${k} is open to a reviewer`);
            // the outcome is all they choose: the reviewer (their own account) and the date fill themselves in, and are saved
            await type('#f-compliance-0-outcome', 'approved');
            await until(`document.querySelector('#f-compliance-0-reviewer').value === 'Casey Compliance' && /^\\d{4}-\\d\\d-\\d\\d$/.test(document.querySelector('#f-compliance-0-reviewDate').value)`, 'the reviewer and date to fill in');
            await saved();
            await until(`/Signed off by Casey Compliance/.test(document.querySelector('#reviewNote')?.textContent || '') && /current/.test(document.querySelector('#reviewNote').textContent)`, 'the sign-off note');
            await shot('roles-compliance-signoff');
            await go2(); await openHousehold(); await compliance();
            await expectTrue(js(`document.querySelector('#f-compliance-0-reviewer').value === 'Casey Compliance' && document.querySelector('#f-compliance-0-outcome').value === 'approved'`), 'the sign-off was not kept');

            // -- an adviser: works on the file, cannot sign off, cannot change the firm; changing a client's details makes the sign-off out of date
            await signInAs('sam@example.com');
            await expectTrue(present('[data-act="newBlank"]'), 'an adviser cannot create a household');
            await openHousehold(); await compliance();
            await expectTrue(js(`document.querySelector('#f-compliance-0-reviewer').disabled && document.querySelector('#f-compliance-0-outcome').disabled`), 'an adviser can edit the sign-off');
            await expectTrue(enabled('#f-compliance-0-serviceType'), 'an adviser cannot edit the rest of the file');
            await expectTrue(js(`/recorded by a compliance reviewer/.test(document.querySelector('.lock-note')?.textContent || '')`), 'no note on the sign-off');
            await expectTrue(js(`/The sign-off is current/.test(document.querySelector('#reviewNote')?.textContent || '')`), 'the sign-off should be current before the edit');
            await nav('members'); await until(`!!document.querySelector('#f-members-0-niNumber')`, 'the first person');
            await type('#f-members-0-niNumber', 'QQ123456C');
            await saved();
            await compliance();
            await until(`/The sign-off is out of date/.test(document.querySelector('#reviewNote')?.textContent || '')`, 'the sign-off to be marked out of date', 5000);
            await expectTrue(js(`document.querySelector('#f-compliance-0-outcome').value === 'approved'`), 'the stale sign-off was erased: it should be kept as evidence');
            await shot('roles-adviser-stale-signoff');
            await click('#btnClients'); await until(`document.querySelector('#main h2')?.textContent === 'Households'`, 'the client list');
            await expectTrue(js(`!document.querySelector('[data-act="team"]')`), 'an adviser is offered User accounts');
            await click('[data-act="firmSettings"]'); await until(`document.querySelector('#main h2')?.textContent === 'Firm settings'`, 'Firm settings');
            await expectTrue(js(`document.querySelector('#f-firm-0-name').disabled && /Only a firm administrator/.test(document.querySelector('.lock-note')?.textContent || '')`), 'an adviser can change the firm settings');
            await expectTrue(js(addHidden), 'an adviser is offered "Add" in the firm settings');
            await shot('roles-adviser-firm-readonly');

            // -- an administrator: the team (roles to tick, invitations) and the firm settings; not the sign-off
            await signInAs('dana@example.com');
            await expectTrue(present('[data-act="team"]'), 'an administrator is not offered User accounts');
            await click('[data-act="team"]'); await until(`document.querySelector('#main h2')?.textContent === 'User accounts' && document.querySelectorAll('#main tbody tr').length >= 4`, 'the team', 10000);
            await expectTrue(js(`document.querySelectorAll('#main tbody tr').length === 4 && document.querySelectorAll('input[data-act="memberRoles"]').length === 3 * 3`), 'three boxes of roles for everyone but yourself');
            // a new person with two roles (adviser is ticked already: add compliance)
            await type('#invName', 'Pat Newcomer'); await type('#invEmail', 'pat@example.com');
            await js(`(() => { document.querySelector('#invRoles input[value="compliance"]').click(); return true; })()`);
            await click('[data-act="invite"]');
            await until(`/Invitation sent to pat@example.com/.test(document.querySelector('#main .banner')?.textContent || '')`, 'the invitation', 10000);
            await until(`[...document.querySelectorAll('#main tbody tr')].some(tr => /pat@example.com/.test(tr.textContent) && tr.querySelectorAll('input:checked').length === 2)`, 'the new person with both roles');
            // roles ticked and unticked in the table apply at once; a person always keeps one
            const tick = async (email, role) => {
              await js(`(() => { document.querySelector('input[data-act="memberRoles"][data-uid="${uid[email]}"][value="${role}"]').click(); return true; })()`);
              await until(`/Roles changed/.test(document.querySelector('#main .banner')?.textContent || '') && document.querySelector('input[data-act="memberRoles"][data-uid="${uid[email]}"][value="${role}"]') !== null`, 'the roles to change', 10000);
            };
            const checked = email => js(`[...document.querySelectorAll('input[data-act="memberRoles"][data-uid="${uid[email]}"]:checked')].map(x => x.value).join('+')`);
            await tick('sam@example.com', 'compliance');
            if (await checked('sam@example.com') !== 'adviser+compliance') throw new Error('Sam\'s roles: ' + await checked('sam@example.com'));
            await shot('roles-admin-team');
            await tick('sam@example.com', 'compliance'); // untick
            await tick('sam@example.com', 'adviser');    // untick the last one: refused, nothing changes
            await until(`/needs at least one role/.test(document.querySelector('#main .banner')?.textContent || '')`, 'the refusal to leave someone with no role', 5000).catch(() => {});
            if (await checked('sam@example.com') !== 'adviser') throw new Error('Sam should still have adviser: ' + await checked('sam@example.com'));
            // an existing account (Ned, administrator of another firm) is invited: pending, nothing open to him yet
            await type('#invName', 'Ned Other'); await type('#invEmail', 'ned@example.com');
            await js(`(() => { document.querySelector('#invRoles input[value="compliance"]').click(); return true; })()`); // adviser is ticked already: both
            await click('[data-act="invite"]');
            await until(`/Invitation sent to ned@example.com/.test(document.querySelector('#main .banner')?.textContent || '')`, 'the invitation to Ned', 10000);
            await until(`[...document.querySelectorAll('#main tbody tr')].some(tr => /ned@example.com/.test(tr.textContent) && /Invitation pending/.test(tr.textContent))`, 'the pending invitation in the table');
            await click('[data-act="firmSettings"]'); await until(`document.querySelector('#main h2')?.textContent === 'Firm settings'`, 'Firm settings');
            await expectTrue(enabled('#f-firm-0-name'), 'an administrator cannot edit the firm settings');
            await expectTrue(js(`!document.querySelector('.lock-note')`), 'a read-only note on the administrator\'s firm settings');

            // -- Ned signs in: the invitation is put to him before any firm is chosen; accepting it opens the firm with the roles he was given
            await cookieFor('ned@example.com', null);
            await page.send('Page.navigate', { url: BASE2 });
            await until(`document.querySelector('#gate h2')?.textContent === 'You have been invited'`, 'the invitation screen', 30000);
            await expectTrue(js(`/Default firm/.test(document.querySelector('#gate').textContent) && /adviser/.test(document.querySelector('#gate').textContent)`), 'the invitation does not say which firm and roles');
            await expectTrue(js(`!document.querySelector('[data-k]') && !document.querySelector('#main .panel:not(#gate)')`), 'data is on screen before the invitation is accepted');
            await shot('roles-invitation');
            await click('[data-gate^="accept:"]');
            await until(`document.querySelector('#gate h2')?.textContent === 'Choose a firm'`, 'the firm picker (he belongs to two firms now)', 15000);
            await click(`[data-gate="firm:${FIRM}"]`);
            await until(`document.querySelector('#main h2')?.textContent === 'Households'`, 'the client list', 15000);
            await expectTrue(js(`/Adviser \\+ Compliance reviewer/.test(document.querySelector('#who').textContent)`), 'the roles he was invited with are not shown');

            // -- someone who holds admin and compliance, and worked on the file, cannot sign it off: someone else must
            await pool.query(`update memberships set extra_roles = array['compliance'] where user_id = $1 and firm_id = $2`, [uid['dana@example.com'], FIRM]);
            await signInAs('dana@example.com');
            await expectTrue(js(`/Administrator \\+ Compliance reviewer/.test(document.querySelector('#who').textContent)`), 'both of her roles are not shown');
            await openHousehold(); await compliance();
            await expectTrue(enabled('#f-compliance-0-outcome'), 'she holds the compliance role, so the sign-off should be open to her');
            await type('#f-compliance-0-outcome', 'declined');
            await until(`document.querySelector('#saveState').textContent === 'Not saved: not permitted'`, 'the refusal', 10000);
            await expectTrue(js(`/worked on this file/.test([...document.querySelectorAll('#main .banner')].map(x => x.textContent).join(' '))`), 'the refusal does not say why');
            await shot('roles-dual-refused');
            await pool.query(`update memberships set extra_roles = '{}' where user_id = $1 and firm_id = $2`, [uid['dana@example.com'], FIRM]);
          } finally { await pool.end(); }
        });
      } finally { expectAuth = false; app2.kill(); }
    } else results.push('INFO  the sign-in screens (session mode) were not checked: set TEST_DATABASE_URL to a scratch database');
  } catch (e) { fail('run stopped: ' + e.message); }
  finally {
    try { page && page.close(); } catch (e) {}
    try { chrome && chrome.kill(); } catch (e) {}
    try { app && app.kill(); } catch (e) {}
    await sleep(400);
    for (const d of [data, profile]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
  }
  fs.mkdirSync(OUT, { recursive: true });
  // Compare with the baseline run. With the clock fixed, screens are byte-identical between runs
  // except those showing the server's own save times (audit trail, client list). Any other change
  // is listed for a person to look at; it does not fail the run.
  const BASELINE = path.join(ROOT, 'docs', 'checklists', 'screens', 'baseline');
  const TIMED = /-(audit|clients-one-household)\.png$/;
  if (LABEL !== 'baseline' && fs.existsSync(BASELINE)) {
    const mine = fs.readdirSync(OUT).filter(f => f.endsWith('.png')), theirs = fs.readdirSync(BASELINE).filter(f => f.endsWith('.png'));
    const changed = mine.filter(f => theirs.includes(f) && !TIMED.test(f) && !fs.readFileSync(path.join(OUT, f)).equals(fs.readFileSync(path.join(BASELINE, f))));
    const added = mine.filter(f => !theirs.includes(f)), missing = theirs.filter(f => !mine.includes(f));
    results.push(changed.length || added.length || missing.length
      ? `LOOK  differs from baseline: ${[...changed, ...added.map(f => f + ' (new)'), ...missing.map(f => f + ' (missing)')].join(', ')}`
      : 'SAME  every screen matches baseline (audit trail and client list show live save times and are not compared)');
    console.log('  ' + results.at(-1));
  }
  fs.writeFileSync(path.join(OUT, 'report.txt'), `Screen check ${LABEL}\nApp: server.js, file storage, demo login; browser clock ${FROZEN}\nBrowser: ${CHROME}\n\n${results.join('\n')}\n`);
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Report: ${path.relative(ROOT, path.join(OUT, 'report.txt'))}`);
  process.exit(failed ? 1 : 0);
})();
