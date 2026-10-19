/* Server settings, read once at start-up from the environment and from the back end's .env file
   (backend/.env, else .env in the project root). Variables already in the environment win over the file. load() returns every setting or throws an
   Error whose message is what the server prints before it stops. */
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKUP_COMMANDS = ['backup', 'restore-drill'];
// Commands run by the platform operator (cli/accounts.js, cli/platform.js): they need no sign-in users and no DATA_KEY
const OPERATOR_COMMANDS = ['create-user', 'set-password', 'firm-create', 'firm-list', 'firm-seats', 'firm-status', 'access-review', 'grant-operator'];

// Same rule as process.loadEnvFile: a variable already set (even to '') is never replaced
function readEnvFile(file, env) {
  if (!fs.existsSync(file)) return;
  if (typeof util.parseEnv !== 'function') {
    console.warn('.env found but this Node version cannot read it (needs 20.12+). Set the variables in the environment instead.');
    return;
  }
  const parsed = util.parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) if (!(k in env)) env[k] = v;
}

// AUTH_USERS: name:salt:hash entries separated by ';'. Incomplete entries are ignored; a complete
// entry whose salt or hash is not what hash-password prints is refused here, at start-up, rather
// than failing with a server error when that person signs in.
function parseUsers(text) {
  const users = new Map();
  for (const entry of (text || '').split(';').map(s => s.trim()).filter(Boolean)) {
    const [name, salt, hash] = entry.split(':');
    if (!(name && salt && hash)) continue;
    if (!/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(hash)) throw new Error(`AUTH_USERS entry for "${name}" is malformed: expected name:salt:hash exactly as printed by node server.js hash-password.`);
    users.set(name, { salt, hash: Buffer.from(hash, 'hex') });
  }
  return users;
}

// The back end's settings file: backend/.env when there is one, else the project root's .env (where it
// always was). One file only, never both, so a setting cannot come from two places.
// The settings file: HWP_ENV_FILE if the environment names one (a file that does not exist means no file: how a test
// keeps a developer's own settings out), else backend/.env, else the project root's .env
const envFileOf = root => { if (process.env.HWP_ENV_FILE) return path.resolve(process.env.HWP_ENV_FILE); const own = path.join(root, 'backend', '.env'); return fs.existsSync(own) ? own : path.join(root, '.env'); };

function load({ env = process.env, root = ROOT, command } = {}) {
  readEnvFile(envFileOf(root), env);

  let key = null;
  if (env.DATA_KEY) {
    key = Buffer.from(env.DATA_KEY, 'base64');
    if (key.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded. Run: node server.js gen-key');
  }
  // NODE_ENV=production: the settings that are fine on a developer's machine but never in production
  const production = env.NODE_ENV === 'production';
  // The backup commands run as a job of their own, apart from the server: the server's settings do not apply to them
  const backupCommand = BACKUP_COMMANDS.includes(command);
  // The platform operator's commands send no email and use their own database connection, so the server's address and mail settings do not apply to them
  // (migrate-status is read-only and run from a worker or a PC: like those commands it needs no mail, address or key)
  const operatorCommand = OPERATOR_COMMANDS.includes(command) || command === 'migrate-status';
  if (production && !backupCommand) {
    // (the operator commands use their own connection, so the operator's machine never holds the app's password)
    if (!env.DATABASE_URL && !operatorCommand) throw new Error('NODE_ENV=production: DATABASE_URL is required. Client records are kept in PostgreSQL in production, never in files.');
    if (env.ALLOW_PLAINTEXT === '1') throw new Error('NODE_ENV=production: ALLOW_PLAINTEXT is not accepted. Set DATA_KEY so client records are encrypted.');
    if (env.HSTS === '0') throw new Error('NODE_ENV=production: HSTS=0 is not accepted. The app must be served over HTTPS.');
    if (env.AUTH_USERS) throw new Error("NODE_ENV=production: AUTH_USERS (HTTP Basic sign-in) is not accepted. It is for development only; production uses the app's own sign-in.");
    // The app's own sign-in: a Secure cookie and links in emails need an https address; the links and warnings need a mail server over TLS
    if (!operatorCommand && !/^https:\/\/[^/]+\/?$/i.test(env.PUBLIC_URL || '')) throw new Error('NODE_ENV=production: PUBLIC_URL must be the https address the app is served at (the session cookie is Secure and the sign-in links point there).');
    if (!operatorCommand && !env.SMTP_URL) throw new Error('NODE_ENV=production: SMTP_URL is required. Password reset links, invitations and sign-in warnings are sent by email.');
    if (!operatorCommand && /[?&]tls=off\b/i.test(env.SMTP_URL)) throw new Error('NODE_ENV=production: SMTP_URL with tls=off is not accepted. Mail must travel over TLS.');
  }
  // NEW_DATA_KEY: only for node server.js rotate-key
  let newKey = null;
  if (env.NEW_DATA_KEY) {
    newKey = Buffer.from(env.NEW_DATA_KEY, 'base64');
    if (newKey.length !== 32) throw new Error('NEW_DATA_KEY must be 32 bytes, base64-encoded. Run: node server.js gen-key');
  }
  // The owner connection must be to the same database as the app's: migrations run where the data is
  const same = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.host === y.host && x.pathname === y.pathname; } catch (e) { return false; } };
  if (env.DATABASE_URL && env.DATABASE_OWNER_URL && !same(env.DATABASE_URL, env.DATABASE_OWNER_URL)) throw new Error('DATABASE_OWNER_URL must point at the same host and database as DATABASE_URL (only the user differs).');
  // The platform operator's connection (operator commands only, as the operator role) is checked the same way
  if (env.DATABASE_URL && env.DATABASE_OPERATOR_URL && !same(env.DATABASE_URL, env.DATABASE_OPERATOR_URL)) throw new Error('DATABASE_OPERATOR_URL must point at the same host and database as DATABASE_URL (only the user differs).');
  // DB_LOGIN_MODE: "separate" (default: the owner, app and operator roles of the migrations) or "single"
  // (one login that owns the tables and runs the app, for hosts that cannot create roles, such as
  // DCDeploy; db/single-login.js). With one login there is no other connection to name: the owner and
  // operator connections are DATABASE_URL with operator mode (and, for the owner's maintenance work,
  // maintenance mode) switched on for that session, which the server's own connections never do.
  const dbLoginMode = env.DB_LOGIN_MODE || 'separate';
  if (!['separate', 'single'].includes(dbLoginMode)) throw new Error('DB_LOGIN_MODE must be "separate" or "single"');
  const singleLogin = dbLoginMode === 'single';
  if (singleLogin && (env.DATABASE_OWNER_URL || env.DATABASE_OPERATOR_URL)) throw new Error('DB_LOGIN_MODE=single: leave DATABASE_OWNER_URL and DATABASE_OPERATOR_URL unset. There is one login, DATABASE_URL; commands switch on operator or maintenance mode for their own session.');
  if (singleLogin && !env.DATABASE_URL && !BACKUP_COMMANDS.includes(command)) throw new Error('DB_LOGIN_MODE=single needs DATABASE_URL (single-login mode is for PostgreSQL).');
  const withModes = (url, modes) => { if (!url) return ''; const u = new URL(url); const o = u.searchParams.get('options'); u.searchParams.set('options', [o, ...modes.map(m => `-c app.${m}=on`)].filter(Boolean).join(' ')); return u.toString(); };
  const users = parseUsers(env.AUTH_USERS);
  // Sessions (the app's own sign-in): idle and absolute limits; cookies are Secure with the __Host-
  // prefix in production or whenever the app is served over HTTPS (PUBLIC_URL)
  const minutes = (name, dflt) => { const v = env[name] === undefined || env[name] === '' ? dflt : +env[name]; if (!(v > 0)) throw new Error(`${name} must be a positive number`); return v; };
  const sessionIdleMinutes = minutes('SESSION_IDLE_MINUTES', 30), sessionAbsoluteHours = minutes('SESSION_ABSOLUTE_HOURS', 12);
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  // FRONTEND_ORIGIN: the split-address mode, the front end on another address than this back end (the
  // browser then calls this address directly, with CORS). A comma-separated list of origins, scheme and
  // host and port only; unset (the default) means one address, the web tier passing /api/ along. Production
  // takes https only; there is no wildcard.
  const frontendOrigins = String(env.FRONTEND_ORIGIN || '').trim() === '' ? [] : String(env.FRONTEND_ORIGIN).split(',').map(s => {
    const o = s.trim().replace(/\/+$/, '').toLowerCase();
    if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o)) throw new Error(`FRONTEND_ORIGIN: "${s.trim()}" is not an origin. Give the front end's address as https://app.example.com (no path, no wildcard), several separated by commas.`);
    if (production && !o.startsWith('https://')) throw new Error(`FRONTEND_ORIGIN: production takes https origins only (${o}).`);
    return o;
  });
  // SESSION_SAMESITE: strict, lax or none. Strict (the default) holds while the front end and the back end are one
  // site (the web tier passing /api/ along, or two subdomains of one registered domain, or two ports on localhost).
  // On two unrelated addresses the browser needs None, which is Secure and https only: the default there.
  const sameSiteRaw = String(env.SESSION_SAMESITE || '').trim().toLowerCase();
  if (sameSiteRaw && !['strict', 'lax', 'none'].includes(sameSiteRaw)) throw new Error('SESSION_SAMESITE must be strict, lax or none');
  const cookiesSecure = production || /^https:/i.test(publicUrl);
  if (sameSiteRaw === 'none' && !cookiesSecure) throw new Error('SESSION_SAMESITE=none needs an https PUBLIC_URL (a SameSite=None cookie must be Secure)');
  const sessionSameSite = sameSiteRaw ? sameSiteRaw[0].toUpperCase() + sameSiteRaw.slice(1) : frontendOrigins.length && cookiesSecure ? 'None' : 'Strict';
  // Email for the sign-in links and warnings: SMTP_URL (smtp:// with STARTTLS, or smtps://), the sender,
  // and the operator who receives access requests. Without SMTP_URL, outside production, messages go to the log.
  const smtpUrl = env.SMTP_URL || '';
  if (smtpUrl) require('../services/auth/mail.js').parseSmtpUrl(smtpUrl);
  const smtpFrom = env.SMTP_FROM || 'Household Wealth Profiler <no-reply@localhost>';
  const operatorEmail = env.OPERATOR_EMAIL || '';
  // How long a household is kept after its relationship ends, in whole years. The Money Laundering
  // Regulations 2017 (regulation 40) set five; a firm may have reason to keep longer, never shorter.
  const retentionYears = env.RETENTION_YEARS === undefined || env.RETENTION_YEARS === '' ? 5 : +env.RETENTION_YEARS;
  if (!Number.isInteger(retentionYears) || retentionYears < 5 || retentionYears > 100) throw new Error('RETENTION_YEARS must be a whole number of years from 5 (the Money Laundering Regulations 2017 minimum) to 100');
  if (publicUrl && !/^https?:\/\/[^/]+$/i.test(publicUrl)) throw new Error('PUBLIC_URL must be the address the app is served at, e.g. https://profiler.example.com');
  // With PostgreSQL the app's own sign-in (accounts in the database) is the way in and AUTH_USERS is
  // optional (development only). With files, Basic sign-in is the only way in. The data commands run without either.
  // Backups (node server.js backup, restore-drill): BACKUP_KEY is a key of its own, never DATA_KEY, so a
  // stolen backup and a stolen server key are separate losses; the backup job does not need DATA_KEY at
  // all (the restore drill does, to prove records still open). BACKUP_DATABASE_URL is a role that may
  // read every row (superuser or BYPASSRLS), never hwp_app or hwp_owner, for which row security hides rows.
  let backupKey = null;
  if (env.BACKUP_KEY) {
    backupKey = Buffer.from(env.BACKUP_KEY, 'base64');
    if (backupKey.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes, base64-encoded. Run: node server.js gen-key');
    if (key && backupKey.equals(key)) throw new Error('BACKUP_KEY must not be the same as DATA_KEY: keep them apart, so one stolen key never opens both the server and its backups.');
  }
  const backupRetentionDays = env.BACKUP_RETENTION_DAYS === undefined || env.BACKUP_RETENTION_DAYS === '' ? 35 : +env.BACKUP_RETENTION_DAYS;
  if (!Number.isInteger(backupRetentionDays) || backupRetentionDays < 1 || backupRetentionDays > 3650) throw new Error('BACKUP_RETENTION_DAYS must be a whole number of days from 1 to 3650');
  if (!users.size && !env.DATABASE_URL && !['import-files', 'migrate', 'index-references', 'rotate-key', 'check-records', 'subject-access-user', 'check-db-posture', 'migrate-status', ...BACKUP_COMMANDS, ...OPERATOR_COMMANDS].includes(command)) throw new Error('No users configured. Set AUTH_USERS (run: node server.js hash-password NAME PASSWORD), or DATABASE_URL (accounts then sign in through the app).');
  // The operator commands never touch a client record, so the operator's machine does not need the key
  if (!key && env.ALLOW_PLAINTEXT !== '1' && command !== 'backup' && command !== 'check-db-posture' && command !== 'migrate-status' && !OPERATOR_COMMANDS.includes(command)) throw new Error('DATA_KEY is not set. Client data would be stored unencrypted. Set DATA_KEY, or ALLOW_PLAINTEXT=1 for local testing only.');

  return {
    root,
    production,
    port: +env.PORT || 8080,
    // No HOST: every address, IPv6 and IPv4 both (Node binds "::" dual-stack, or 0.0.0.0 where the machine has no
    // IPv6), as a Node server started with no address does; a HOST names one address exactly
    host: env.HOST || '',
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    databaseUrl: env.DATABASE_URL || '',
    // The owner connection for migrations (node server.js migrate); the server itself runs as the
    // app role in DATABASE_URL, which cannot change the schema or bypass row-level security
    databaseOwnerUrl: singleLogin ? withModes(env.DATABASE_URL, ['operator', 'maintenance']) : env.DATABASE_OWNER_URL || '',
    // The platform operator's connection: the operator role cannot read client records (db/operator.sql);
    // in single-login mode, the one login with operator mode on (accounts and firms, no client rows)
    databaseOperatorUrl: singleLogin ? withModes(env.DATABASE_URL, ['operator']) : env.DATABASE_OPERATOR_URL || '',
    singleLogin,
    databasePoolMax: +env.DATABASE_POOL_MAX || 10,
    // Behind a hosting proxy every connection comes from the proxy. Name the header the proxy sets
    // to the real client address (Fly.io: fly-client-ip). Only set this when the proxy overwrites it.
    clientIpHeader: (env.CLIENT_IP_HEADER || '').toLowerCase(),
    // Optional: Alpha Vantage key for automatic monthly fund prices (services/prices.js)
    alphavantageKey: env.ALPHAVANTAGE_KEY || '',
    users,
    key,
    newKey,
    hsts: env.HSTS !== '0',
    // SERVE_WEB=0: the API answers /api/, /healthz and /readyz only; the screens are served by the
    // web tier (frontend as its own service, behind the same domain). The default, one server, is for development.
    serveWeb: env.SERVE_WEB !== '0',
    // The folder the screens are served from: frontend/src as it is (development), or a built
    // frontend/dist (node scripts/build-web.js) to check the build the web tier serves
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : path.join(root, 'frontend', 'src'),
    // TOTP_REQUIRED=0 switches the second step (authenticator code) off: the password alone signs in.
    // Development and early trials only; never with real client data.
    totpRequired: env.TOTP_REQUIRED !== '0',
    sessionIdleMinutes,
    sessionAbsoluteHours,
    publicUrl,
    secureCookies: cookiesSecure,
    frontendOrigins,
    sessionSameSite,
    smtpUrl,
    smtpFrom,
    operatorEmail,
    retentionYears,
    backupUrl: env.BACKUP_DATABASE_URL || '',
    backupDir: env.BACKUP_DIR ? path.resolve(env.BACKUP_DIR) : '',
    backupKey,
    backupRetentionDays,
    // Where pg_dump and pg_restore are, when they are not on the PATH (their major version must be at least the server's)
    pgBin: env.PG_BIN || '',
  };
}

module.exports = { load, parseUsers, envFileOf, ROOT, OPERATOR_COMMANDS };
