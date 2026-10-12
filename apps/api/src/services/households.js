/* Households: the work behind the API, independent of HTTP. Uses packages/core for every rule
   (normalising what is saved, the field-level diff for the audit trail, the client-list summary)
   and a store from repositories/ for keeping it. Every call carries the context from sign-in,
   { user, firmId }: the store is scoped to that firm, so nothing outside it can be reached.
     list(ctx)                    client-list summaries, most recently changed first; a record that
                                  cannot be read is logged with its id and left out
     create(ctx, state, { idempotencyKey })
                                  { id, version: 1 }; the same user and key again within a day
                                  (a double-click, a retried request) returns the first reply.
                                  Refused (409) when another household in the firm already has the
                                  same client reference, in any spelling
     get(ctx, id)                 the record, or null
     audit(ctx, id)               audit entries newest first (at most 5000), or null if no household
     save(ctx, id, { version, state })
                                  { version, changes }   saved (changes 0: nothing changed, no new version)
                                  { notFound: true }
                                  { conflict: { version, updatedBy, updatedAt } }   someone saved since `version`
   Writes to one household happen one at a time in this process; the PostgreSQL store also locks the row. */
'use strict';
const crypto = require('crypto');
const { normaliseReference } = require('../crypto/seal.js');

const AUDIT_LIMIT = 5000;

// The summary the client list shows for each household. A household the rules cannot evaluate
// still lists, with stage "Error".
function summarise(HWP, rec) {
  const s = HWP.normalise(rec.state);
  let stage = '', rating = '', nextReview = '', blockers = 0, due = '', overdue = 0;
  try { const E = HWP.bind(s); const O = E.onboarding(E.compute()); stage = O.stage; rating = O.rating; nextReview = O.nextReview; blockers = O.blockerCount; const R = E.reviews(O); due = R.nextDue; overdue = R.overdue; } catch (e) { stage = 'Error'; }
  return { id: rec.id, name: s.household.name, reference: s.household.reference, stage, rating, nextReview, blockers, due, overdue, tasks: HWP.openTasks(s), version: rec.version, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
}

function createHouseholdService({ store, HWP, now = () => new Date().toISOString(), newId = () => crypto.randomUUID(), log = (...a) => console.error(new Date().toISOString(), ...a), production = false }) {
  // The sample household is for trying the app; a production server keeps real client files only
  const refuseSample = s => { if (production && s.isSample) throw Object.assign(new Error('Sample households are not allowed in production'), { status: 400 }); };
  // One write at a time per household (keys include the firm, so firms never queue behind each other)
  const locks = new Map();
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  }
  // What is stored for submitted state: only known fields, and never a browser-side audit list
  const clean = state => { const s = HWP.normalise(state); delete s.audit; return s; };
  const forFirm = ctx => store.forFirm(ctx.firmId);

  return {
    async list(ctx) {
      const records = await forFirm(ctx).list({ onUnreadable: (id, e) => log(`unreadable household ${id}: ${e.message}`) });
      const list = records.map(rec => summarise(HWP, rec));
      list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return list;
    },

    async create(ctx, state, { idempotencyKey } = {}) {
      const s = clean(state);
      refuseSample(s);
      const scoped = forFirm(ctx);
      const ts = now();
      const rec = { id: newId(), version: 1, state: s, createdAt: ts, createdBy: ctx.user, updatedAt: ts, updatedBy: ctx.user };
      const idem = idempotencyKey ? { user: ctx.user, key: idempotencyKey } : null;
      // Repeats with the same key queue behind each other, so the second sees the first's reply
      return withLock(`${ctx.firmId}:` + (idem ? `create:${ctx.user}:${idempotencyKey}` : rec.id), async () => {
        // A repeat of a create that already went through replays its reply: its own reference is not "taken"
        if (idem) { const prev = await scoped.recall(idem); if (prev) return prev; }
        await refuseTakenReference(scoped, s, null);
        return asDuplicate(s, scoped.create(rec, [{ ts, user: ctx.user, field: 'created', from: '', to: s.household.name || '' }], idem));
      });
    },

    get: (ctx, id) => forFirm(ctx).get(id),

    async audit(ctx, id) {
      const scoped = forFirm(ctx);
      if (!(await scoped.get(id))) return null;
      return (await scoped.audit(id)).slice(0, AUDIT_LIMIT);
    },

    async save(ctx, id, { version, state } = {}) {
      const s = clean(state);
      refuseSample(s);
      const scoped = forFirm(ctx);
      await refuseTakenReference(scoped, s, id);
      return withLock(`${ctx.firmId}:${id}`, () => asDuplicate(s, scoped.update(id, rec => {
        if (!rec) return { result: { notFound: true } };
        if (+version !== rec.version) return { result: { conflict: { version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt } } };
        const ts = now();
        const changes = HWP.diff(rec.state, s).map(c => ({ ts, user: ctx.user, ...c, version: rec.version + 1 }));
        if (!changes.length) return { result: { version: rec.version, changes: 0 } };
        const next = { ...rec, version: rec.version + 1, state: s, updatedAt: ts, updatedBy: ctx.user };
        return { next, audit: changes, result: { version: next.version, changes: changes.length } };
      })));
    },
  };
}

// A client reference may exist once per firm. The check looks before writing (a clear 409); the
// database's unique index catches the race between two writes, which is answered the same way.
const taken = s => Object.assign(new Error(`A household with reference "${normaliseReference(s.household.reference)}" already exists`), { status: 409 });
async function refuseTakenReference(scoped, s, ownId) {
  const hmac = await scoped.indexReference(s.household.reference);
  if (!hmac) return;
  const owner = await scoped.findByReference(hmac);
  if (owner && owner !== ownId) throw taken(s);
}
async function asDuplicate(s, write) {
  try { return await write; } catch (e) { if (e.code === '23505' && /households_reference_unique/.test(e.message + (e.constraint || ''))) throw taken(s); throw e; }
}

module.exports = { createHouseholdService, summarise, AUDIT_LIMIT };
