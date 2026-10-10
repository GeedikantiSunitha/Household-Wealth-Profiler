/* Households: the work behind the API, independent of HTTP. Uses packages/core for every rule
   (normalising what is saved, the field-level diff for the audit trail, the client-list summary)
   and a store from repositories/ for keeping it.
     list()                       client-list summaries, most recently changed first
     create(state, user)          { id, version: 1 }
     get(id)                      the record, or null
     audit(id)                    audit entries newest first (at most 5000), or null if no household
     save(id, { version, state }, user)
                                  { version, changes }   saved (changes 0: nothing changed, no new version)
                                  { notFound: true }
                                  { conflict: { version, updatedBy, updatedAt } }   someone saved since `version`
   Writes to one household happen one at a time in this process; the PostgreSQL store also locks the row. */
'use strict';
const crypto = require('crypto');

const AUDIT_LIMIT = 5000;

// The summary the client list shows for each household. A household the rules cannot evaluate
// still lists, with stage "Error".
function summarise(HWP, rec) {
  const s = HWP.normalise(rec.state);
  let stage = '', rating = '', nextReview = '', blockers = 0, due = '', overdue = 0;
  try { const E = HWP.bind(s); const O = E.onboarding(E.compute()); stage = O.stage; rating = O.rating; nextReview = O.nextReview; blockers = O.blockerCount; const R = E.reviews(O); due = R.nextDue; overdue = R.overdue; } catch (e) { stage = 'Error'; }
  return { id: rec.id, name: s.household.name, reference: s.household.reference, stage, rating, nextReview, blockers, due, overdue, version: rec.version, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
}

function createHouseholdService({ store, HWP, now = () => new Date().toISOString(), newId = () => crypto.randomUUID() }) {
  // One write at a time per household
  const locks = new Map();
  function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(id, next.catch(() => {}));
    return next;
  }
  // What is stored for submitted state: only known fields, and never a browser-side audit list
  const clean = state => { const s = HWP.normalise(state); delete s.audit; return s; };

  return {
    async list() {
      const list = (await store.list()).map(rec => summarise(HWP, rec));
      list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return list;
    },

    async create(state, user) {
      const s = clean(state);
      const ts = now();
      const rec = { id: newId(), version: 1, state: s, createdAt: ts, createdBy: user, updatedAt: ts, updatedBy: user };
      await withLock(rec.id, () => store.create(rec, [{ ts, user, field: 'created', from: '', to: s.household.name || '' }]));
      return { id: rec.id, version: rec.version };
    },

    get: id => store.get(id),

    async audit(id) {
      if (!(await store.get(id))) return null;
      return (await store.audit(id)).slice(0, AUDIT_LIMIT);
    },

    save(id, { version, state } = {}, user) {
      return withLock(id, () => store.update(id, rec => {
        if (!rec) return { result: { notFound: true } };
        if (+version !== rec.version) return { result: { conflict: { version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt } } };
        const s = clean(state);
        const ts = now();
        const changes = HWP.diff(rec.state, s).map(c => ({ ts, user, ...c, version: rec.version + 1 }));
        if (!changes.length) return { result: { version: rec.version, changes: 0 } };
        const next = { ...rec, version: rec.version + 1, state: s, updatedAt: ts, updatedBy: user };
        return { next, audit: changes, result: { version: next.version, changes: changes.length } };
      }));
    },
  };
}

module.exports = { createHouseholdService, summarise, AUDIT_LIMIT };
