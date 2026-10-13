/* Households: the work behind the API, independent of HTTP. Uses packages/core for every rule
   (normalising what is saved, the field-level diff for the audit trail, the client-list summary)
   and a store from repositories/ for keeping it. Every call carries the context from sign-in,
   { user, firmId }: the store is scoped to that firm, so nothing outside it can be reached.
     list(ctx)                    client-list summaries, most recently changed first; a record that
                                  cannot be read is logged with its id and left out
     create(ctx, state, { idempotencyKey })
                                  { id, version: 1 }; the same user and key again within a day
                                  (a double-click, a retried request) returns the first reply.
                                  Refused (409 duplicate_reference) when another household in the
                                  firm already has the same client reference, in any spelling, and
                                  (400 invalid_field, with the list of problems) when a value breaks
                                  the field rules in validate.js; the same on save
   Every call first checks the roles in ctx against services/access.js: 403 forbidden (or, for the
   review sign-off, 403 sign_off_identity / separation_of_duties, 400 four_eyes) before anything is
   read or written. The review sign-off is the signed-in compliance reviewer's: the server puts their
   name and today's date on it, and keeps with it the version and a fingerprint of the onboarding
   assessment it was recorded on (services/signoff.js). get() adds review ({ by, at, version }) and
   reviewStale to a record that has one; a save that changes a record's sign-off or whether it is
   stale says so in its reply. Each record also keeps the accounts that have changed it, which is what
   separation of duties is judged on (never sent to the browser).
     get(ctx, id)                 the record, or null
     audit(ctx, id)               audit entries newest first (at most 5000), or null if no household
     save(ctx, id, { version, state })
                                  { version, changes }   saved (changes 0: nothing changed, no new version)
                                  { notFound: true }
                                  { conflict: { version, updatedBy, updatedAt } }   someone saved since `version`
   Writes to one household happen one at a time in this process; the PostgreSQL store also locks the row. */
'use strict';
const crypto = require('crypto');
const { validateHousehold, invalidError } = require('./validate.js');
const { authorize, guardSave, guardCreate, touchesSignOff, stampSignOff, withContributor, SIGN_OFF_FIELDS } = require('./access.js');
const signoff = require('./signoff.js');

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
  const refuseSample = s => { if (production && s.isSample) throw Object.assign(new Error('Sample households are not allowed in production'), { status: 400, code: 'sample_refused' }); };
  // The field rules, on the normalised state; canonical values (numbers, booleans, option text) are what gets stored
  const refuseInvalid = s => { const errors = validateHousehold(HWP, s); if (errors.length) throw invalidError('Invalid household', errors); };
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
      authorize(ctx, 'households.read');
      const records = await forFirm(ctx).list({ onUnreadable: (id, e) => log(`unreadable household ${id}: ${e.message}`) });
      const list = records.map(rec => summarise(HWP, rec));
      list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return list;
    },

    async create(ctx, state, { idempotencyKey } = {}) {
      const s = clean(state);
      guardCreate(ctx, s, HWP);
      refuseSample(s);
      refuseInvalid(s);
      const scoped = forFirm(ctx);
      const ts = now();
      const rec = { id: newId(), version: 1, state: s, createdAt: ts, createdBy: ctx.user, updatedAt: ts, updatedBy: ctx.user };
      const authors = withContributor({}, ctx); if (authors) rec.contributors = authors;
      // The request goes with the key: the same key with a different request is refused (422), not replayed
      const idem = idempotencyKey ? { user: ctx.user, key: idempotencyKey, request: JSON.stringify(s) } : null;
      // Repeats with the same key queue behind each other, so the second sees the first's reply
      return withLock(`${ctx.firmId}:` + (idem ? `create:${ctx.user}:${idempotencyKey}` : rec.id), async () => {
        // A repeat of a create that already went through replays its reply: its own reference is not "taken"
        if (idem) { const prev = await scoped.recall(idem); if (prev) return prev; }
        await refuseTakenReference(scoped, s, null);
        return asDuplicate(s, scoped.create(rec, [{ ts, user: ctx.user, field: 'created', from: '', to: s.household.name || '' }], idem));
      });
    },

    async get(ctx, id) {
      authorize(ctx, 'households.read');
      const rec = await forFirm(ctx).get(id);
      if (!rec) return rec;
      const { contributors, review, ...out } = rec; // who changed the file is for the server's rules, not the browser
      if (review) { out.review = signoff.publicReview(rec); out.reviewStale = signoff.isStale(HWP, rec); }
      return out;
    },

    async audit(ctx, id) {
      authorize(ctx, 'households.audit');
      const scoped = forFirm(ctx);
      if (!(await scoped.get(id))) return null;
      return (await scoped.audit(id)).slice(0, AUDIT_LIMIT);
    },

    async save(ctx, id, { version, state } = {}) {
      authorize(ctx, 'households.read'); // before anything is looked up; what the role may change is decided below, against the stored record
      const s = clean(state);
      refuseSample(s);
      refuseInvalid(s);
      const scoped = forFirm(ctx);
      await refuseTakenReference(scoped, s, id);
      return withLock(`${ctx.firmId}:${id}`, () => asDuplicate(s, scoped.update(id, rec => {
        if (!rec) return { result: { notFound: true } };
        if (+version !== rec.version) return { result: { conflict: { version: rec.version, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt } } };
        const ts = now();
        let diff = HWP.diff(rec.state, s);
        // The reviewer and the review date are not typed: the server puts the signed-in reviewer and today on a sign-off
        if (touchesSignOff(diff)) { stampSignOff(ctx, s, ts.slice(0, 10)); diff = HWP.diff(rec.state, s); }
        guardSave(ctx, diff, s, rec); // what these roles may change, and separation of duties; throwing here rolls the transaction back
        const changes = diff.map(c => ({ ts, user: ctx.user, ...c, version: rec.version + 1 }));
        if (!changes.length) return { result: { version: rec.version, changes: 0 } };
        const next = { ...rec, version: rec.version + 1, state: s, updatedAt: ts, updatedBy: ctx.user };
        if (diff.some(c => !SIGN_OFF_FIELDS.includes(c.field))) { const who = withContributor(rec, ctx); if (who) next.contributors = who; }
        const review = signoff.reviewAfter({ HWP, rec, next, diff, ctx, at: ts });
        if (review === null) delete next.review; else if (review) next.review = review;
        const result = { version: next.version, changes: changes.length };
        if (next.review) { result.review = signoff.publicReview(next); result.reviewStale = signoff.isStale(HWP, next); } else if (rec.review) result.review = null;
        return { next, audit: changes, result };
      })));
    },
  };
}

// A client reference may exist once per firm. The check looks before writing (a clear 409); the
// database's unique index catches the race between two writes, which is answered the same way.
const taken = () => Object.assign(new Error('Another household in this firm already has this client reference'), { status: 409, code: 'duplicate_reference' });
async function refuseTakenReference(scoped, s, ownId) {
  const hmac = await scoped.indexReference(s.household.reference);
  if (!hmac) return;
  const owner = await scoped.findByReference(hmac);
  if (owner && owner !== ownId) throw taken();
}
async function asDuplicate(s, write) {
  try { return await write; } catch (e) { if (e.code === '23505' && /households_reference_unique/.test(e.message + (e.constraint || ''))) throw taken(); throw e; }
}

module.exports = { createHouseholdService, summarise, AUDIT_LIMIT };
