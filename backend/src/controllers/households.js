/* Household controllers: each reads its input, calls the household service once with the sign-in
   context { user, firmId, ... } and turns the outcome into a reply. Which method and path reaches
   which is routes/households.js. There is deliberately no delete: records are kept for
   regulatory retention. */
'use strict';

const IDEM_KEY = /^[A-Za-z0-9_-]{8,200}$/;

function createHouseholdController({ households, send, readBody }) {
  return {
    // GET /api/households: the client list
    async list(req, res, ctx) { send(res, 200, await households.list(ctx)); },
    // POST /api/households: 201 {id, version}; 409 when the firm already has that client reference.
    // With an Idempotency-Key header a repeat within a day gets the first reply; a bad key is 400
    async create(req, res, ctx) {
      const key = req.headers['idempotency-key'];
      if (key !== undefined && !IDEM_KEY.test(key)) return send(res, 400, { error: 'Idempotency-Key must be 8 to 200 letters, digits, "-" or "_"', code: 'bad_idempotency_key' });
      const body = await readBody(req);
      send(res, 201, await households.create(ctx, body.state, key ? { idempotencyKey: key } : undefined));
    },
    // GET /api/households/:id: the record with the normalised state; 404 if unknown
    async get(req, res, ctx, { id }) {
      const rec = await households.get(ctx, id);
      rec ? send(res, 200, rec) : send(res, 404, { error: 'Not found' });
    },
    // GET /api/households/:id/audit: the audit trail, newest first; 404 if unknown
    async audit(req, res, ctx, { id }) {
      const entries = await households.audit(ctx, id);
      entries ? send(res, 200, entries) : send(res, 404, { error: 'Not found' });
    },
    // PUT /api/households/:id: save {version, state}: 200 {version, changes} | 404 | 409
    async save(req, res, ctx, { id }) {
      const r = await households.save(ctx, id, await readBody(req));
      if (r.notFound) send(res, 404, { error: 'Not found' });
      else if (r.conflict) send(res, 409, { error: 'This household was changed by someone else', code: 'version_conflict', ...r.conflict });
      else send(res, 200, r);
    },
  };
}

module.exports = { createHouseholdController, IDEM_KEY };
