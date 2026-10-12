/* Storage for households. Two stores with the same shape; DATABASE_URL picks PostgreSQL, otherwise
   files under DATA_DIR. Records and audit entries are sealed before they are stored.
     list({ onUnreadable })  every current record that can be read; onUnreadable(id, error) for
                          each that cannot (default: logged), so one bad record hides nothing else
     get(id)              current record or null
     create(rec, audit, idem?)  new household at version 1; returns { id, version }. With
                          idem = { user, key }, a repeat within a day returns the first reply
                          instead of creating again
     update(id, decide)   decide(current) returns { result, next?, audit? }; when next is given it is
                          saved as the new version together with its audit entries, atomically
     audit(id)            audit entries, newest first
     firm.get()           the firm settings record, or null before the first save
     firm.update(decide)  as update(), for the firm settings record
     firm.audit()         the firm settings audit entries, newest first
     init()               prepare storage (create the folder, or apply db/migrations)
     ready()              resolves when storage answers (for /readyz), else rejects
     describe             where the data is, for the start-up line */
'use strict';
const path = require('path');
const { ID_RE } = require('./ids.js');
const { createFileStore } = require('./file-store.js');
const { createPgStore } = require('./pg-store.js');

function createStore(config, sealer) {
  if (!config.databaseUrl) return createFileStore(config.dataDir, sealer);
  return createPgStore(config.databaseUrl, { ...sealer, poolMax: config.databasePoolMax, migrationsDir: path.join(config.root, 'db', 'migrations') });
}

module.exports = { createStore, createFileStore, createPgStore, ID_RE };
