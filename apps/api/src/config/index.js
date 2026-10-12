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

// AUTH_USERS: name:salt:hash entries separated by ';'. Incomplete entries are ignored.
function parseUsers(text) {
  const users = new Map();
  for (const entry of (text || '').split(';').map(s => s.trim()).filter(Boolean)) {
    const [name, salt, hash] = entry.split(':');
    if (name && salt && hash) users.set(name, { salt, hash: Buffer.from(hash, 'hex') });
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
  const users = parseUsers(env.AUTH_USERS);
  // import-files only copies data, so it runs without sign-in users
  if (!users.size && command !== 'import-files') throw new Error('No users configured. Set AUTH_USERS (run: node server.js hash-password NAME PASSWORD).');
  if (!key && env.ALLOW_PLAINTEXT !== '1') throw new Error('DATA_KEY is not set. Client data would be stored unencrypted. Set DATA_KEY, or ALLOW_PLAINTEXT=1 for local testing only.');

  return {
    root,
    port: +env.PORT || 8080,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    databaseUrl: env.DATABASE_URL || '',
    databasePoolMax: +env.DATABASE_POOL_MAX || 10,
    // Behind a hosting proxy every connection comes from the proxy. Name the header the proxy sets
    // to the real client address (Fly.io: fly-client-ip). Only set this when the proxy overwrites it.
    clientIpHeader: (env.CLIENT_IP_HEADER || '').toLowerCase(),
    // Optional: Alpha Vantage key for automatic monthly fund prices (services/prices.js)
    alphavantageKey: env.ALPHAVANTAGE_KEY || '',
    users,
    key,
    hsts: env.HSTS !== '0',
  };
}

module.exports = { load, parseUsers, ROOT };
