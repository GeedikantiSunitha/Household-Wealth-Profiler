/* Records and data protection controllers (Phase 4). Each reads its input, calls the records
   service once with the sign-in context and turns the outcome into a reply. Still no delete
   anywhere: the only deletion is an approved purge, which is a decision on a request. Everything
   except the export log needs the admin or compliance role; the service refuses (403 forbidden)
   and logs the refusal, so no route guard pre-empts it. Which method and path reaches which is
   routes/records.js. */
'use strict';

const notFound = (send, res) => send(res, 404, { error: 'Not found' });

function createRecordsController({ records, send, readBody }) {
  const reply = (res, r, status = 200) => (r ? send(res, status, r) : notFound(send, res));
  return {
    // GET /api/records: the records page: households, retention, purge requests
    async overview(req, res, ctx) { send(res, 200, await records.overview(ctx)); },
    // POST /api/purge-requests/:id/approve|reject {note}: 200 | 403 | 404 | 409
    async decidePurge(req, res, ctx, { id, decision }) {
      const body = await readBody(req);
      reply(res, await records.decidePurge(ctx, id, { approve: decision === 'approve', note: body.note }));
    },
    // POST /api/households/:id/exports {kind: excel|json|print}: 200 {logged: true} | 404
    async logExport(req, res, ctx, { id }) { reply(res, await records.logExport(ctx, id, (await readBody(req)).kind)); },
    // GET /api/households/:id/access: the access log, newest first | 404
    async accessLog(req, res, ctx, { id }) { reply(res, await records.accessLog(ctx, id)); },
    // PUT /api/households/:id/relationship {endedOn: 'YYYY-MM-DD' | null}: 200 {endedOn, retentionUntil} | 404 | 409
    async setRelationship(req, res, ctx, { id }) { reply(res, await records.setRelationship(ctx, id, await readBody(req))); },
    // POST /api/households/:id/purge-requests {reason}: 201 the request | 404 | 409
    async requestPurge(req, res, ctx, { id }) { reply(res, await records.requestPurge(ctx, id, await readBody(req)), 201); },
    // GET /api/households/:id/subject-access: the subject access export, as a JSON download | 404
    async subjectAccess(req, res, ctx, { id }) {
      const r = await records.subjectAccess(ctx, id);
      if (!r) return notFound(send, res);
      const name = `subject-access-${(r.household.reference || id).replace(/[^\w-]+/g, '_')}-${r.generatedAt.slice(0, 10)}.json`;
      send(res, 200, r, { 'Content-Disposition': `attachment; filename="${name}"` });
    },
  };
}

module.exports = { createRecordsController };
