// backend/src/config: every setting, its default, and the exact start-up refusals.
// Each test passes its own environment and an empty project folder, so a developer's .env never counts.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, parseUsers } = require('../../backend/src/config');

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-config-'));
const USER = `sam:${'ab'.repeat(16)}:${'cd'.repeat(64)}`;
const KEY = crypto.randomBytes(32).toString('base64');
const ok = (extra = {}, opts = {}) => load({ env: { AUTH_USERS: USER, DATA_KEY: KEY, ...extra }, root: root(), ...opts });

test('defaults when only users and key are set', () => {
  const r = root();
  const c = load({ env: { AUTH_USERS: USER, DATA_KEY: KEY }, root: r });
  assert.equal(c.port, 8080);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.dataDir, path.join(r, 'data'));
  assert.equal(c.databaseUrl, '');
  assert.equal(c.databaseOwnerUrl, '', 'migrations run with DATABASE_URL unless an owner URL is given');
  assert.equal(c.databasePoolMax, 10);
  assert.equal(c.clientIpHeader, '');
  assert.equal(c.hsts, true);
  assert.equal(c.key.length, 32);
  assert.equal(c.root, r);
});

test('settings from the environment', () => {
  const c = ok({ PORT: '9001', HOST: '127.0.0.1', DATA_DIR: 'some/dir', DATABASE_URL: 'postgres://x', DATABASE_OWNER_URL: 'postgres://owner@x', DATABASE_POOL_MAX: '3', CLIENT_IP_HEADER: 'Fly-Client-IP', HSTS: '0' });
  assert.equal(c.port, 9001);
  assert.equal(c.databaseOwnerUrl, 'postgres://owner@x');
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.dataDir, path.resolve('some/dir'));
  assert.equal(c.databaseUrl, 'postgres://x');
  assert.equal(c.databasePoolMax, 3);
  assert.equal(c.clientIpHeader, 'fly-client-ip');
  assert.equal(c.hsts, false);
  assert.equal(c.sessionIdleMinutes, 30); assert.equal(c.sessionAbsoluteHours, 12); assert.equal(c.publicUrl, ''); assert.equal(c.secureCookies, false);
  const s = ok({ SESSION_IDLE_MINUTES: '15', SESSION_ABSOLUTE_HOURS: '8', PUBLIC_URL: 'https://profiler.example.com/' });
  assert.equal(s.sessionIdleMinutes, 15); assert.equal(s.sessionAbsoluteHours, 8); assert.equal(s.publicUrl, 'https://profiler.example.com'); assert.equal(s.secureCookies, true);
  assert.equal(ok({ PUBLIC_URL: 'http://localhost:8080' }).secureCookies, false);
  assert.throws(() => ok({ SESSION_IDLE_MINUTES: '0' }), /SESSION_IDLE_MINUTES must be a positive number/);
  assert.throws(() => ok({ SESSION_ABSOLUTE_HOURS: 'soon' }), /SESSION_ABSOLUTE_HOURS must be a positive number/);
  assert.throws(() => ok({ PUBLIC_URL: 'profiler.example.com' }), /PUBLIC_URL must be the address/);
  assert.deepEqual([c.smtpUrl, c.smtpFrom, c.operatorEmail], ['', 'Household Wealth Profiler <no-reply@localhost>', '']);
  const m = ok({ SMTP_URL: 'smtps://u:p@mail.example.com', SMTP_FROM: 'Profiler <no-reply@example.com>', OPERATOR_EMAIL: 'ops@example.com' });
  assert.deepEqual([m.smtpUrl, m.smtpFrom, m.operatorEmail], ['smtps://u:p@mail.example.com', 'Profiler <no-reply@example.com>', 'ops@example.com']);
  assert.throws(() => ok({ SMTP_URL: 'mail.example.com' }), /SMTP_URL must start with smtp/);
});

test('AUTH_USERS: entries split on ";", incomplete ones ignored, hash kept as bytes', () => {
  const users = parseUsers(` ${USER} ; chris:${'ef'.repeat(16)}:${'01'.repeat(64)};broken:onlysalt;;`);
  assert.deepEqual([...users.keys()], ['sam', 'chris']);
  assert.equal(users.get('sam').salt, 'ab'.repeat(16));
  assert.ok(Buffer.isBuffer(users.get('sam').hash));
  assert.equal(users.get('sam').hash.length, 64);
});

test('start-up refusals keep their exact messages', () => {
  assert.throws(() => load({ env: { AUTH_USERS: USER, DATA_KEY: 'c2hvcnQ=' }, root: root() }),
    { message: 'DATA_KEY must be 32 bytes, base64-encoded. Run: node server.js gen-key' });
  assert.throws(() => load({ env: { DATA_KEY: KEY }, root: root() }),
    { message: 'No users configured. Set AUTH_USERS (run: node server.js hash-password NAME PASSWORD), or DATABASE_URL (accounts then sign in through the app).' });
  // With PostgreSQL the accounts live in the database: no AUTH_USERS needed, in development or production
  assert.equal(load({ env: { DATA_KEY: KEY, DATABASE_URL: 'postgres://x' }, root: root() }).users.size, 0);
  assert.equal(load({ env: { NODE_ENV: 'production', DATA_KEY: KEY, DATABASE_URL: 'postgres://x', PUBLIC_URL: 'https://profiler.example.com', SMTP_URL: 'smtps://u:p@mail.example.com' }, root: root() }).users.size, 0, 'a production server starts without Basic users');
  assert.throws(() => load({ env: { AUTH_USERS: USER }, root: root() }),
    { message: 'DATA_KEY is not set. Client data would be stored unencrypted. Set DATA_KEY, or ALLOW_PLAINTEXT=1 for local testing only.' });
});

test('NODE_ENV=production refuses files, plaintext, plain HTTP and Basic sign-in', () => {
  const prod = extra => load({ env: { NODE_ENV: 'production', DATA_KEY: KEY, DATABASE_URL: 'postgres://x', PUBLIC_URL: 'https://profiler.example.com', SMTP_URL: 'smtps://u:p@mail.example.com', ...extra }, root: root() });
  assert.throws(() => prod({ DATABASE_URL: '' }),
    { message: 'NODE_ENV=production: DATABASE_URL is required. Client records are kept in PostgreSQL in production, never in files.' });
  assert.throws(() => prod({ DATA_KEY: '', ALLOW_PLAINTEXT: '1' }),
    { message: 'NODE_ENV=production: ALLOW_PLAINTEXT is not accepted. Set DATA_KEY so client records are encrypted.' });
  assert.throws(() => prod({ HSTS: '0' }),
    { message: 'NODE_ENV=production: HSTS=0 is not accepted. The app must be served over HTTPS.' });
  assert.throws(() => prod({ AUTH_USERS: USER }),
    { message: "NODE_ENV=production: AUTH_USERS (HTTP Basic sign-in) is not accepted. It is for development only; production uses the app's own sign-in." });
  // Until the app's own sign-in exists (Phase 2) there is no way to sign in to a production server
  assert.equal(prod({}).users.size, 0, 'production starts without Basic users: accounts sign in through the app');
  // the app's own sign-in needs an https address (Secure cookies, links in emails) and a way to send those emails
  assert.throws(() => prod({ PUBLIC_URL: '' }), { message: 'NODE_ENV=production: PUBLIC_URL must be the https address the app is served at (the session cookie is Secure and the sign-in links point there).' });
  assert.throws(() => prod({ PUBLIC_URL: 'http://profiler.example.com' }), { message: 'NODE_ENV=production: PUBLIC_URL must be the https address the app is served at (the session cookie is Secure and the sign-in links point there).' });
  assert.throws(() => prod({ SMTP_URL: '' }), { message: 'NODE_ENV=production: SMTP_URL is required. Password reset links, invitations and sign-in warnings are sent by email.' });
  assert.throws(() => prod({ SMTP_URL: 'smtp://mail.example.com?tls=off' }), { message: 'NODE_ENV=production: SMTP_URL with tls=off is not accepted. Mail must travel over TLS.' });
  const p = prod({});
  assert.equal(p.secureCookies, true); assert.equal(p.publicUrl, 'https://profiler.example.com');
  // outside production none of this is required
  assert.equal(load({ env: { DATA_KEY: KEY, DATABASE_URL: 'postgres://x' }, root: root() }).publicUrl, '');
  assert.equal(ok().production, false, 'NODE_ENV unset is not production');
  assert.equal(ok({ NODE_ENV: 'development', ALLOW_PLAINTEXT: '1', DATA_KEY: '' }).production, false);
});

test('DATABASE_OWNER_URL must name the same host and database as DATABASE_URL', () => {
  assert.equal(ok({ DATABASE_URL: 'postgres://hwp_app:a@db.example:5432/hwp', DATABASE_OWNER_URL: 'postgres://hwp_owner:b@db.example:5432/hwp' }).databaseOwnerUrl, 'postgres://hwp_owner:b@db.example:5432/hwp');
  for (const other of ['postgres://hwp_owner:b@other.example:5432/hwp', 'postgres://hwp_owner:b@db.example:5432/other', 'not a url'])
    assert.throws(() => ok({ DATABASE_URL: 'postgres://hwp_app:a@db.example:5432/hwp', DATABASE_OWNER_URL: other }),
      { message: 'DATABASE_OWNER_URL must point at the same host and database as DATABASE_URL (only the user differs).' }, other);
});

test('a malformed AUTH_USERS entry is refused at start-up, not as a server error at sign-in', () => {
  for (const bad of [`sam:${'ab'.repeat(16)}:${'cd'.repeat(63)}`, `sam:${'ab'.repeat(15)}:${'cd'.repeat(64)}`, `sam:${'zz'.repeat(16)}:${'cd'.repeat(64)}`]) {
    assert.throws(() => parseUsers(bad), { message: 'AUTH_USERS entry for "sam" is malformed: expected name:salt:hash exactly as printed by node server.js hash-password.' }, bad);
  }
  assert.throws(() => load({ env: { AUTH_USERS: `sam:${'ab'.repeat(16)}:${'cd'.repeat(63)}`, DATA_KEY: KEY }, root: root() }), /malformed/);
});

test('ALLOW_PLAINTEXT=1 runs without a key; import-files runs without users', () => {
  assert.equal(load({ env: { AUTH_USERS: USER, ALLOW_PLAINTEXT: '1' }, root: root() }).key, null);
  assert.equal(load({ env: { DATA_KEY: KEY }, root: root(), command: 'import-files' }).users.size, 0);
  for (const cmd of ['migrate', 'index-references', 'rotate-key', 'check-records', 'create-user', 'set-password']) assert.equal(load({ env: { DATA_KEY: KEY }, root: root(), command: cmd }).users.size, 0, cmd);
});

test('.env in the project folder fills gaps but never replaces what is already set', () => {
  const r = root();
  fs.writeFileSync(path.join(r, '.env'), `AUTH_USERS=${USER}\nDATA_KEY=${KEY}\nPORT=7000\nHOST=10.0.0.1\nHSTS=0\n`);
  const env = { HOST: '127.0.0.1', HSTS: '' };
  const c = load({ env, root: r });
  assert.equal(c.port, 7000, 'PORT comes from .env');
  assert.equal(c.host, '127.0.0.1', 'HOST already set: .env does not win');
  assert.equal(c.hsts, true, 'HSTS already set, even to empty: .env does not win');
  assert.equal(env.PORT, '7000', '.env values are added to the environment, as process.loadEnvFile does');
});

test('operator commands (Phase 3): no users, no DATA_KEY and, in production, no DATABASE_URL; the operator URL must name the app\'s database', () => {
  for (const cmd of ['firm-create', 'firm-list', 'firm-seats', 'firm-status', 'access-review', 'grant-operator', 'create-user', 'set-password']) {
    assert.equal(load({ env: {}, root: root(), command: cmd }).users.size, 0, `${cmd} needs no users and no key`);
    assert.doesNotThrow(() => load({ env: { NODE_ENV: 'production', DATABASE_OPERATOR_URL: 'postgres://hwp_operator:x@db.example/wealth' }, root: root(), command: cmd }), `${cmd} in production`);
  }
  // the server itself, and the data commands, still need their settings
  assert.throws(() => load({ env: { DATABASE_URL: 'postgres://a@h/db' }, root: root() }), /DATA_KEY is not set/);
  assert.throws(() => load({ env: { NODE_ENV: 'production', DATA_KEY: KEY }, root: root() }), /DATABASE_URL is required/);
  // the production refusals that are about secrets stay for operator commands too
  assert.throws(() => load({ env: { NODE_ENV: 'production', HSTS: '0' }, root: root(), command: 'firm-list' }), /HSTS=0 is not accepted/);
  assert.throws(() => load({ env: { NODE_ENV: 'production', ALLOW_PLAINTEXT: '1' }, root: root(), command: 'firm-list' }), /ALLOW_PLAINTEXT is not accepted/);
  assert.equal(load({ env: { DATABASE_OPERATOR_URL: 'postgres://o:x@h/db' }, root: root(), command: 'firm-list' }).databaseOperatorUrl, 'postgres://o:x@h/db');
  assert.equal(load({ env: {}, root: root(), command: 'firm-list' }).databaseOperatorUrl, '');
  assert.equal(load({ env: { DATA_KEY: KEY, DATABASE_URL: 'postgres://a:x@h:5432/db', DATABASE_OPERATOR_URL: 'postgres://o:y@h:5432/db' }, root: root() }).databaseOperatorUrl, 'postgres://o:y@h:5432/db');
  assert.throws(() => load({ env: { DATA_KEY: KEY, DATABASE_URL: 'postgres://a:x@h:5432/db', DATABASE_OPERATOR_URL: 'postgres://o:y@h:5432/other' }, root: root() }), /DATABASE_OPERATOR_URL must point at the same host and database as DATABASE_URL/);
  assert.throws(() => load({ env: { DATA_KEY: KEY, DATABASE_URL: 'postgres://a:x@h:5432/db', DATABASE_OPERATOR_URL: 'postgres://o:y@elsewhere:5432/db' }, root: root() }), /same host and database/);
});

test('SERVE_WEB: the server serves the screens unless SERVE_WEB=0 (the web tier serves them, the API answers /api/ only)', () => {
  assert.equal(ok().serveWeb, true, 'default: one server for development');
  assert.equal(ok({ SERVE_WEB: '0' }).serveWeb, false);
  assert.equal(ok({ SERVE_WEB: '1' }).serveWeb, true);
  assert.equal(ok({ SERVE_WEB: '' }).serveWeb, true, 'empty means the default');
  assert.equal(ok().totpRequired, true, 'the second step is required unless switched off');
  assert.equal(ok({ TOTP_REQUIRED: '0' }).totpRequired, false);
  assert.equal(ok({ TOTP_REQUIRED: '1' }).totpRequired, true);
  const r = root();
  assert.equal(load({ env: { AUTH_USERS: USER, DATA_KEY: KEY }, root: r }).webDir, path.join(r, 'frontend', 'src'), 'the screens come from frontend/src unless WEB_DIR says otherwise');
  assert.equal(ok({ WEB_DIR: 'frontend/dist' }).webDir, path.resolve('frontend/dist'));
});
