/* Start-up: puts the layers together and runs a command or the server. `node server.js …` calls
   main(args). The order matters:
     1. commands that need no settings (hash-password, gen-key)
     2. settings (stop with a message when one is missing or wrong)
     3. encryption, storage, the household service, sign-in, the request pipeline
     4. import-files, or prepare storage (apply migrations) and start listening
   Any other first argument starts the server, as before. */
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

function main([cmd, ...args] = []) {
  if (cmd === 'hash-password') process.exit(hashPasswordCommand(args));
  if (cmd === 'gen-key') process.exit(genKeyCommand());

  let config;
  try { config = load({ command: cmd }); } catch (e) { console.error(e.message); process.exit(1); }
  const sealer = createSealer(config.key);
  let store;
  try { store = createStore(config, sealer); } catch (e) { console.error(e.message); process.exit(1); }
  const households = createHouseholdService({ store, HWP });
  const firm = createFirmService({ store, HWP });
  const prices = createPriceService({ key: config.alphavantageKey });
  const { authenticate } = createAuth(config);
  const { server } = createApp({ config, households, firm, prices, authenticate });

  if (cmd === 'import-files') {
    importFiles({ dir: args[0] || config.dataDir, databaseUrl: config.databaseUrl, store, sealer })
      .then(code => { if (code) process.exit(code); }, e => { console.error(e.message); process.exit(1); });
    return;
  }
  store.init().then(() => {
    server.listen(config.port, config.host, () => console.log(`Household Wealth Profiler on http://${config.host}:${config.port} · ${config.users.size} user(s) · encryption ${config.key ? 'on' : 'OFF'} · ${store.describe}`));
  }, e => { console.error('Could not open storage:', e.message); process.exit(1); });
  return server;
}

module.exports = { main };
