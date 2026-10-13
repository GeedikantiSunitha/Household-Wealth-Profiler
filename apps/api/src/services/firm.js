/* Firm settings (firm details, team, providers, fund library): one record per firm, versioned
   and audited like a household. Uses packages/core to normalise and diff the settings. Every call
   carries the context from sign-in, { user, firmId }.
     get(ctx)                       { version, settings, updatedAt, updatedBy }  (version 0 and the
                                    default settings before the first save)
     audit(ctx)                     audit entries newest first (at most 5000)
     save(ctx, { version, settings })
                                    { version, changes }   saved (changes 0: nothing changed)
                                    { conflict: { version, updatedBy, updatedAt } }   someone saved since `version`
                                    throws 400 invalid_field (with the list of problems) when a value
                                    breaks the field rules in validate.js
   Saves happen one at a time per firm in this process; the PostgreSQL store also locks across processes. */
'use strict';
const { AUDIT_LIMIT } = require('./households.js');
const { validateFirm, invalidError } = require('./validate.js');

function createFirmService({ store, HWP, now = () => new Date().toISOString() }) {
  const blank = () => ({ version: 0, settings: HWP.firmBlank(), updatedAt: '', updatedBy: '' });
  const queues = new Map();
  const withLock = (firmId, fn) => { const next = (queues.get(firmId) || Promise.resolve()).then(fn, fn); queues.set(firmId, next.catch(() => {})); return next; };
  const forFirm = ctx => store.forFirm(ctx.firmId).firm;

  return {
    async get(ctx) { return (await forFirm(ctx).get()) || blank(); },

    async audit(ctx) { return (await forFirm(ctx).audit()).slice(0, AUDIT_LIMIT); },

    save(ctx, { version, settings } = {}) {
      const s = HWP.firmNormalise(settings);
      const errors = validateFirm(HWP, s);
      if (errors.length) throw invalidError('Invalid firm settings', errors);
      return withLock(ctx.firmId, () => forFirm(ctx).update(current => {
        const rec = current || blank();
        if (+version !== rec.version) return { result: { conflict: { version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt } } };
        const ts = now();
        const changes = HWP.firmDiff(rec.settings, s).map(c => ({ ts, user: ctx.user, ...c, version: rec.version + 1 }));
        if (!changes.length) return { result: { version: rec.version, changes: 0 } };
        const next = { version: rec.version + 1, settings: s, updatedAt: ts, updatedBy: ctx.user };
        return { next, audit: changes, result: { version: next.version, changes: changes.length } };
      }));
    },
  };
}

module.exports = { createFirmService };
