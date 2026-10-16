/* Records and data protection (Phase 4): the access log, exports made in the browser, the subject
   access export, the retention clock and approved purge. Independent of HTTP; every call carries the
   sign-in context { user, userId, firmId, role, session }.
     logExport(ctx, id, kind)     an export made in the browser: 'excel', 'json' or 'print'. Any user
                                  who can open the household. null if there is no such household
     accessLog(ctx, id)           who read the household, newest first (at most 5000), or null
     overview(ctx)                the records page: every household with its retention, the purge
                                  requests (pending, rejected, purged) and the retention period
     setRelationship(ctx, id, { endedOn })
                                  endedOn 'YYYY-MM-DD' (today or earlier) ends the relationship and
                                  starts the clock: retention runs to that day plus RETENTION_YEARS;
                                  null reopens it. Refused while a purge request waits (409
                                  purge_pending). { endedOn, retentionUntil }, or null if no household
     requestPurge(ctx, id, { reason })
                                  only once the retention period has ended (409 retention_not_ended)
     decidePurge(ctx, requestId, { approve, note })
                                  approve: by a different person from the requester (403
                                  same_person); the household, every version, its change audit and
                                  its retention row are deleted, and the request stays as the purge
                                  register with the counts. Reject: anyone allowed, including the
                                  requester withdrawing it
     subjectAccess(ctx, id)       everything kept for the household as one package, with a cover
                                  listing every person in it, for redaction before release
   Every action except logExport belongs to a firm's administrators and compliance users (any of a
   person's roles being admin or compliance, services/access.js; 403 forbidden otherwise). Development Basic sign-in carries no role and is allowed;
   production refuses Basic sign-in, and here refuses any call without a session.
   Every read, every refusal on role and every unknown household is written to the access log. */
'use strict';
const { summarise } = require('./households.js');
const { can } = require('./access.js');

const EXPORT_KINDS = new Set(['excel', 'json', 'print']);
const TEXT_MAX = 500;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// A real calendar day 'YYYY-MM-DD', or null
function day(v) {
  const m = DAY.exec(String(v || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === v && +m[1] >= 1900 ? v : null;
}
// The day the retention period ends: the same calendar day, `years` later (29 February runs to 1 March)
function addYears(d, years) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCFullYear(t.getUTCFullYear() + years);
  return t.toISOString().slice(0, 10);
}
const text = (v, name) => {
  const s = String(v == null ? '' : v).trim();
  if (s.length > TEXT_MAX) throw fail(400, 'bad_request', `${name} must be at most ${TEXT_MAX} characters`);
  return s;
};
const personName = m => [m.title, m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.ref || '(no name)';

function createRecordsService({ store, HWP, retentionYears = 5, production = false, now = () => new Date() }) {
  const forFirm = ctx => store.forFirm(ctx.firmId);
  const today = () => now().toISOString().slice(0, 10);
  const log = (ctx, action, householdId, outcome = 'ok', detail = '') => forFirm(ctx).logAccess({ actor: ctx.user, userId: ctx.userId || null, action, householdId, outcome, detail });
  const who = ctx => ({ by: ctx.user, byId: ctx.userId || null });

  // Administrators and compliance users only; a refusal is logged
  async function requireManager(ctx, action, householdId = null) {
    if (ctx.session ? can(ctx, 'records.manage') : !production) return; // roles: services/access.js (a person may hold several)
    await log(ctx, action, householdId, 'forbidden');
    throw fail(403, 'forbidden', 'Only a firm administrator or compliance user can do this');
  }
  // The household, or null after logging the attempt as not_found
  async function household(ctx, action, id) {
    const rec = await forFirm(ctx).get(id);
    if (!rec) await log(ctx, action, id, 'not_found');
    return rec;
  }

  return {
    retentionYears,

    async logExport(ctx, id, kind) {
      if (!EXPORT_KINDS.has(kind)) throw fail(400, 'bad_request', `kind must be one of ${[...EXPORT_KINDS].join(', ')}`);
      if (!(await household(ctx, 'export', id))) return null;
      await log(ctx, 'export', id, 'ok', kind);
      return { logged: true };
    },

    async accessLog(ctx, id) {
      await requireManager(ctx, 'access_log', id);
      if (!(await household(ctx, 'access_log', id))) return null;
      const entries = await forFirm(ctx).accessLog(id);
      await log(ctx, 'access_log', id);
      return entries;
    },

    async overview(ctx) {
      await requireManager(ctx, 'records');
      const scoped = forFirm(ctx);
      const [records, retention, requests] = await Promise.all([scoped.list(), scoped.retention.all(), scoped.purge.list()]);
      const byId = new Map(retention.map(r => [r.householdId, r]));
      const t = today();
      const households = records.map(rec => {
        const s = summarise(HWP, rec), r = byId.get(rec.id);
        const endedOn = r ? r.endedOn : null, retentionUntil = r ? r.retentionUntil : null;
        return { id: rec.id, name: s.name, reference: s.reference, stage: s.stage, updatedAt: rec.updatedAt, endedOn, retentionUntil, eligible: !!retentionUntil && retentionUntil < t };
      }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const names = new Map(households.map(h => [h.id, h.name]));
      await log(ctx, 'records', null, 'ok', `${households.length} household(s)`);
      return { today: t, retentionYears, households, requests: requests.map(q => ({ ...q, householdName: names.get(q.householdId) || '' })) };
    },

    async setRelationship(ctx, id, { endedOn } = {}) {
      await requireManager(ctx, 'retention', id);
      let ended = null;
      if (endedOn !== null && endedOn !== '' && endedOn !== undefined) {
        ended = day(endedOn);
        if (!ended) throw fail(400, 'bad_request', 'endedOn must be a date written YYYY-MM-DD');
        if (ended > today()) throw fail(400, 'bad_request', 'The relationship cannot end on a day still to come');
      } else if (endedOn === undefined) throw fail(400, 'bad_request', 'endedOn is required: the day the relationship ended, or null to reopen it');
      const result = await forFirm(ctx).retention.update(id, async found => {
        if (!found) return { result: null };
        const prev = found.current && found.current.endedOn || null;
        const retentionUntil = ended ? addYears(ended, retentionYears) : null;
        if (prev === ended) return { result: { endedOn: ended, retentionUntil: found.current ? found.current.retentionUntil : null } };
        if (found.pending) throw fail(409, 'purge_pending', 'A purge request for this household is waiting for a decision. Reject it first.');
        const ts = now().toISOString();
        return { next: { endedOn: ended, retentionUntil, by: ctx.user }, audit: [{ ts, user: ctx.user, field: 'relationship.endedOn', from: prev || '', to: ended || '' }], result: { endedOn: ended, retentionUntil } };
      });
      if (result === null) await log(ctx, 'retention', id, 'not_found');
      return result;
    },

    async requestPurge(ctx, id, { reason } = {}) {
      await requireManager(ctx, 'purge_request', id);
      const why = text(reason, 'reason');
      if (!why) throw fail(400, 'bad_request', 'Give the reason for the purge');
      const scoped = forFirm(ctx);
      if (!(await household(ctx, 'purge_request', id))) return null;
      const ret = await scoped.retention.get(id);
      if (!ret || !ret.endedOn) throw fail(409, 'relationship_open', "This household's relationship has not ended");
      if (!(ret.retentionUntil < today())) throw fail(409, 'retention_not_ended', `The retention period runs until ${ret.retentionUntil}. A purge can be requested from the day after.`);
      return scoped.purge.request({ householdId: id, reason: why, ...who(ctx) });
    },

    async decidePurge(ctx, requestId, { approve, note } = {}) {
      await requireManager(ctx, approve ? 'purge_approve' : 'purge_reject');
      if (typeof approve !== 'boolean') throw fail(400, 'bad_request', 'approve must be true or false');
      const n = text(note, 'note');
      const scoped = forFirm(ctx);
      const req = await scoped.purge.get(requestId);
      if (!req) return null;
      if (req.status !== 'pending') throw fail(409, 'already_decided', `This purge request was already ${req.status}`);
      if (!approve) return { request: await scoped.purge.reject(requestId, { ...who(ctx), note: n }) };
      const mine = req.requestedBy === ctx.user || (!!ctx.userId && req.requestedById === ctx.userId);
      if (mine) { await log(ctx, 'purge_approve', req.householdId, 'forbidden', 'own request'); throw fail(403, 'same_person', 'A purge is approved by a different person from the one who requested it'); }
      const counts = await scoped.purge.execute(requestId, { ...who(ctx), note: n });
      return { purged: true, householdId: req.householdId, counts };
    },

    async subjectAccess(ctx, id) {
      await requireManager(ctx, 'subject_access', id);
      const scoped = forFirm(ctx);
      const record = await household(ctx, 'subject_access', id);
      if (!record) return null;
      const [versions, changeAudit, accessLog, retention] = await Promise.all([scoped.versions(id), scoped.audit(id), scoped.accessLog(id, { limit: Infinity }), scoped.retention.get(id)]);
      const s = HWP.normalise(record.state);
      await log(ctx, 'subject_access', id);
      return {
        kind: 'subject-access-export',
        format: 1,
        generatedAt: now().toISOString(),
        generatedBy: ctx.user,
        firmId: ctx.firmId,
        household: { id, name: s.household.name || '', reference: s.household.reference || '' },
        notice: [
          'This file holds every record the firm keeps for this household: the current record, every saved version, the change audit trail, the access log and the retention status.',
          'It covers everyone in the household. Before releasing it to the person who asked, remove or redact the personal data of every other person listed under "people", unless they have agreed to its release (UK GDPR Article 15(4)).',
          "Names in the audit trail and the access log are the firm's staff.",
          'Reply within one month of receiving the request (UK GDPR Article 12(3)).',
        ],
        people: (s.members || []).map(m => ({ ref: m.ref, name: personName(m), role: m.role })),
        record,
        versions,
        changeAudit,
        accessLog,
        retention: retention ? { endedOn: retention.endedOn, retentionUntil: retention.retentionUntil } : { endedOn: null, retentionUntil: null },
      };
    },
  };
}

module.exports = { createRecordsService, addYears, day };
