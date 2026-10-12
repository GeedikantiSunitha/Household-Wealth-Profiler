/* Start-up: puts the layers together and runs a command or the server. `node server.js …` calls
   main(args). The order matters:
     1. commands that need no settings (hash-password, gen-key)
     2. settings (stop with a message when one is missing or wrong)
     3. encryption, storage, the household service, sign-in, the request pipeline
     4. import-files, or prepare storage (apply migrations) and start listening
   Any other first argument starts the server, as before.
   On SIGTERM or SIGINT (the host stopping the container, Ctrl-C) the server stops taking new
   connections, lets requests in flight finish, closes storage and exits 0; if that takes longer
   than 10 seconds it exits 1. */
'use strict';
const HWP = require('../../../packages/core/core.js');
const { load } = require('./config');
const { createSealer } = require('./crypto/seal.js');
const { createStore } = require('./repositories');
const { createHouseholdService } = require('./services/households.js');
const { createFirmService } = require('./services/firm.js');
const { createPriceService } = require('./services/prices.js');
const { createAuth } = require('./auth');
const { createApp } = require('./app.js');
const { hashPasswordCommand, genKeyCommand } = require('./cli');
const { importFiles } = require('./cli/import-files.js');

const STOP_TIMEOUT_MS = 10e3;

function stopOnSignal(server, store) {
  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    console.log(new Date().toISOString(), `${signal}: stopping; requests in flight are finishing`);
    const force = setTimeout(() => { console.error(new Date().toISOString(), 'stop timed out'); process.exit(1); }, STOP_TIMEOUT_MS);
    // Connections that finish their request while stopping become idle and are closed on the next sweep
    const sweep = setInterval(() => server.closeIdleConnections(), 100);
    server.close(async () => {
      clearInterval(sweep);
      try { if (store.end) await store.end(); } catch (e) { console.error(new Date().toISOString(), 'closing storage:', e.message); }
      clearTimeout(force);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

function main([cmd, ...args] = []) {
  if (cmd === 'hash-password') process.exit(hashPasswordCommand(args));
  if (cmd === 'gen-key') process.exit(genKeyCommand());

  let config;
  try { config = load({ command: cmd }); } catch (e) { console.error(e.message); process.exit(1); }
  const sealer = createSealer(config.key);
  let store;
  try { store = createStore(config, sealer); } catch (e) { console.error(e.message); process.exit(1); }
  const households = createHouseholdService({ store, HWP, production: config.production });
  const firm = createFirmService({ store, HWP });
  const prices = createPriceService({ key: config.alphavantageKey });
  const { authenticate } = createAuth(config);
  const { server } = createApp({ config, households, firm, prices, authenticate, ready: () => store.ready() });

  if (cmd === 'import-files') {
    importFiles({ dir: args[0] || config.dataDir, databaseUrl: config.databaseUrl, store, sealer })
      .then(code => { if (code) process.exit(code); }, e => { console.error(e.message); process.exit(1); });
    return;
  }
  store.init().then(() => {
    stopOnSignal(server, store);
    server.listen(config.port, config.host, () => console.log(`Household Wealth Profiler on http://${config.host}:${config.port} · ${config.users.size} user(s) · encryption ${config.key ? 'on' : 'OFF'} · ${store.describe}${config.production ? ' · production' : ''}`));
  }, e => { console.error('Could not open storage:', e.message); process.exit(1); });
  return server;
}

module.exports = { main };
