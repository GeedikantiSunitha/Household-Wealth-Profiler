/* Server settings, read once at start-up from the environment and from .env in the project root.
   Variables already in the environment win over .env. load() returns every setting or throws an
   Error whose message is what the server prints before it stops. */
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

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

function load({ env = process.env, root = ROOT, command } = {}) {
  readEnvFile(path.join(root, '.env'), env);

  let key = null;
  if (env.DATA_KEY) {
    key = Buffer.from(env.DATA_KEY, 'base64');
    if (key.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded. Run: node server.js gen-key');
  }
  // NODE_ENV=production: the settings that are fine on a developer's machine but never in production
  const production = env.NODE_ENV === 'production';
  if (production) {
    if (!env.DATABASE_URL) throw new Error('NODE_ENV=production: DATABASE_URL is required. Client records are kept in PostgreSQL in production, never in files.');
    if (env.ALLOW_PLAINTEXT === '1') throw new Error('NODE_ENV=production: ALLOW_PLAINTEXT is not accepted. Set DATA_KEY so client records are encrypted.');
    if (env.HSTS === '0') throw new Error('NODE_ENV=production: HSTS=0 is not accepted. The app must be served over HTTPS.');
    if (env.AUTH_USERS) throw new Error("NODE_ENV=production: AUTH_USERS (HTTP Basic sign-in) is not accepted. It is for development only; production uses the app's own sign-in.");
  }
  // NEW_DATA_KEY: only for node server.js rotate-key
  let newKey = null;
  if (env.NEW_DATA_KEY) {
    newKey = Buffer.from(env.NEW_DATA_KEY, 'base64');
    if (newKey.length !== 32) throw new Error('NEW_DATA_KEY must be 32 bytes, base64-encoded. Run: node server.js gen-key');
  }
  // The owner connection must be to the same database as the app's: migrations run where the data is
  if (env.DATABASE_URL && env.DATABASE_OWNER_URL) {
    const same = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.host === y.host && x.pathname === y.pathname; } catch (e) { return false; } };
    if (!same(env.DATABASE_URL, env.DATABASE_OWNER_URL)) throw new Error('DATABASE_OWNER_URL must point at the same host and database as DATABASE_URL (only the user differs).');
  }
  const users = parseUsers(env.AUTH_USERS);
  // Sessions (the app's own sign-in): idle and absolute limits; cookies are Secure with the __Host-
  // prefix in production or whenever the app is served over HTTPS (PUBLIC_URL)
  const minutes = (name, dflt) => { const v = env[name] === undefined || env[name] === '' ? dflt : +env[name]; if (!(v > 0)) throw new Error(`${name} must be a positive number`); return v; };
  const sessionIdleMinutes = minutes('SESSION_IDLE_MINUTES', 30), sessionAbsoluteHours = minutes('SESSION_ABSOLUTE_HOURS', 12);
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\/[^/]+$/i.test(publicUrl)) throw new Error('PUBLIC_URL must be the address the app is served at, e.g. https://profiler.example.com');
  // With PostgreSQL the app's own sign-in (accounts in the database) is the way in and AUTH_USERS is
  // optional (development only). With files, Basic sign-in is the only way in. The data commands run without either.
  if (!users.size && !env.DATABASE_URL && !['import-files', 'migrate', 'index-references', 'rotate-key', 'check-records', 'create-user', 'set-password'].includes(command)) throw new Error('No users configured. Set AUTH_USERS (run: node server.js hash-password NAME PASSWORD), or DATABASE_URL (accounts then sign in through the app).');
  if (!key && env.ALLOW_PLAINTEXT !== '1') throw new Error('DATA_KEY is not set. Client data would be stored unencrypted. Set DATA_KEY, or ALLOW_PLAINTEXT=1 for local testing only.');

  return {
    root,
    production,
    port: +env.PORT || 8080,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    databaseUrl: env.DATABASE_URL || '',
    // The owner connection for migrations (node server.js migrate); the server itself runs as the
    // app role in DATABASE_URL, which cannot change the schema or bypass row-level security
    databaseOwnerUrl: env.DATABASE_OWNER_URL || '',
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
    sessionIdleMinutes,
    sessionAbsoluteHours,
    publicUrl,
    secureCookies: production || /^https:/i.test(publicUrl),
  };
}

module.exports = { load, parseUsers, ROOT };
