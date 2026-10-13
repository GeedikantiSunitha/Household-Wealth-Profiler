/* Storage for households and firm settings. Two stores with the same shape; DATABASE_URL picks
   PostgreSQL (production), otherwise files under DATA_DIR (development only).
   The root store:
     init()               prepare storage (create the folder, or apply db/migrations; in production
                          only check that none is pending)
     ready()              resolves when storage answers (for /readyz), else rejects
     describe             where the data is, for the start-up line
     forFirm(firmId)      the store scoped to one firm: nothing outside that firm is visible or
                          writable through it
   A firm's store:
     list({ onUnreadable })  every current record that can be read; onUnreadable(id, error) for
                          each that cannot (default: logged), so one bad record hides nothing else
     get(id)              current record or null
     versions(id)         every saved version, oldest first
     create(rec, audit, idem?)  new household at version 1; returns { id, version }. With
                          idem = { user, key }, a repeat within a day returns the first reply
                          instead of creating again
     update(id, decide)   decide(current) returns { result, next?, audit? }; when next is given it is
                          saved as the new version together with its audit entries, atomically
     audit(id)            audit entries, newest first
     indexReference(ref)  the keyed index of a client reference (null for none), per firm
     findByReference(hmac)  the id of the household with that reference index, or null
     firm.get()           the firm settings record, or null before the first save
     firm.update(decide)  as update(), for the firm settings record
     firm.audit()         the firm settings audit entries, newest first
     logAccess({ actor, userId, action, householdId, outcome, detail })
                          one access-log entry (who read what; no client data; never changed)
     accessLog(householdId, { limit })  that household's access-log entries, newest first (at most
                          5000 unless limit says otherwise; Infinity for all)
     retention.all() / retention.get(id)
                          { householdId, endedOn, retentionUntil, changedBy, changedAt } per household
                          whose relationship has ended (or was reopened: endedOn null)
     retention.update(id, decide)
                          decide({ current, pending }) (or decide(null): no such household) returns
                          { result, next?, audit? }; next = { endedOn, retentionUntil, by } is stored
                          with its change-audit entries, atomically
     purge.list() / purge.get(reqId)
                          purge requests, newest first: pending, rejected, and purged (the register)
     purge.request({ householdId, reason, by, byId })   409 relationship_open | purge_pending
     purge.reject(reqId, { by, byId, note })            the request, or null if not pending
     purge.execute(reqId, { by, byId, note })           deletes the household with every version,
                          its change audit and its retention row, after checking again that the
                          request is pending, the approver is not the requester and the retention
                          period has ended (409 purge_refused otherwise); the counts removed
   Records and audit entries are sealed before they are stored. */
'use strict';
const path = require('path');
const { ID_RE, DEFAULT_FIRM_ID } = require('./ids.js');
const { createFileStore } = require('./file-store.js');
const { createPgStore } = require('./pg-store.js');

function createStore(config, sealer) {
  if (!config.databaseUrl) return createFileStore(config.dataDir, sealer);
  return createPgStore(config.databaseUrl, { key: sealer.key, poolMax: config.databasePoolMax, migrationsDir: path.join(config.root, 'db', 'migrations'), ownerUrl: config.databaseOwnerUrl, production: config.production });
}

module.exports = { createStore, createFileStore, createPgStore, ID_RE, DEFAULT_FIRM_ID };
