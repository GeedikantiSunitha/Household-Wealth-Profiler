/* Firm settings (firm details, team, providers, fund library): one record for the whole firm,
   versioned and audited like a household. Uses packages/core to normalise and diff the settings.
     get()                          { version, settings, updatedAt, updatedBy }  (version 0 and the
                                    default settings before the first save)
     audit()                        audit entries newest first (at most 5000)
     save({ version, settings }, user)
                                    { version, changes }   saved (changes 0: nothing changed)
                                    { conflict: { version, updatedBy, updatedAt } }   someone saved since `version`
   Saves happen one at a time in this process; the PostgreSQL store also locks across processes. */
'use strict';
const { AUDIT_LIMIT } = require('./households.js');

function createFirmService({ store, HWP, now = () => new Date().toISOString() }) {
  const blank = () => ({ version: 0, settings: HWP.firmBlank(), updatedAt: '', updatedBy: '' });
  let queue = Promise.resolve();
  const withLock = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

  return {
    async get() { return (await store.firm.get()) || blank(); },

    async audit() { return (await store.firm.audit()).slice(0, AUDIT_LIMIT); },

    save({ version, settings } = {}, user) {
      return withLock(() => store.firm.update(current => {
        const rec = current || blank();
        if (+version !== rec.version) return { result: { conflict: { version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt } } };
        const s = HWP.firmNormalise(settings);
        const ts = now();
        const changes = HWP.firmDiff(rec.settings, s).map(c => ({ ts, user, ...c, version: rec.version + 1 }));
        if (!changes.length) return { result: { version: rec.version, changes: 0 } };
        const next = { version: rec.version + 1, settings: s, updatedAt: ts, updatedBy: user };
        return { next, audit: changes, result: { version: next.version, changes: changes.length } };
      }));
    },
  };
}

module.exports = { createFirmService };
