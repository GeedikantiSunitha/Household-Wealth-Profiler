/* A route table: which method and path reaches which controller, with that route's own guards.
   The backend runs one direction only: a route names a controller, the controller calls one
   service, the service uses the repositories. A table keeps the route file to that one job.
     createRouteTable(entries, { send, ID_RE }) -> route(req, res, p, ctx)
       a promise of true when the request was one of these routes (and has been answered), false
       when the path is none of them (the next table is tried; app.js answers 404 after the last)
     entry: {
       path:    '/api/x' or a RegExp whose groups are the parameters, in order
       params:  the parameters' names, one per group, e.g. ['id']
       ids:     the parameters that must be a uuid (404 "Not found" otherwise, before any guard)
       guards:  per-route guards (middleware/guards.js), run in order: a refusal is sent as it is
       methods: { GET: handler, PUT: handler, ... }   handler(req, res, ctx, params)
       strict:  true answers 405 "Method not allowed" for another method on this path; otherwise
                the path counts as not matched (404 from app.js), as the API has always done */
'use strict';

function createRouteTable(entries, { send, ID_RE = /^[0-9a-f-]{36}$/i }) {
  return async function route(req, res, p, ctx) {
    for (const e of entries) {
      const m = e.path instanceof RegExp ? e.path.exec(p) : (p === e.path ? [p] : null);
      if (!m) continue;
      const handler = e.methods[req.method];
      if (!handler) {
        if (e.strict) { send(res, 405, { error: 'Method not allowed' }); return true; }
        continue;
      }
      const params = {};
      (e.params || []).forEach((name, i) => { params[name] = m[i + 1]; });
      if ((e.ids || []).some(name => !ID_RE.test(params[name] || ''))) { send(res, 404, { error: 'Not found' }); return true; }
      for (const guard of e.guards || []) {
        const refused = guard({ req, p, auth: ctx, params });
        if (refused) { send(res, ...refused); return true; }
      }
      await handler(req, res, ctx, params);
      return true;
    }
    return false;
  };
}

module.exports = { createRouteTable };
