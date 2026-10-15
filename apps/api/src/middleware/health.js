/* Gate 2, health: GET /healthz answers 200 {ok:true} as soon as the process is up, and GET /readyz
   answers 200 {ok:true} once storage answers too, else 503 {ok:false} with no detail. Both answer
   before sign-in: they are for the host's checks. ready() must answer within the time limit. */
'use strict';

const READY_TIMEOUT_MS = 3000;

function withinTime(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), ms); })]).finally(() => clearTimeout(timer));
}

function createHealth({ ready = async () => {}, send, timeoutMs = READY_TIMEOUT_MS }) {
  return async function health(ctx) {
    if (ctx.p === '/healthz') { send(ctx.res, 200, { ok: true }); return true; }
    if (ctx.p === '/readyz') {
      try { await withinTime(ready(), timeoutMs); send(ctx.res, 200, { ok: true }); }
      catch (e) { console.error(new Date().toISOString(), 'not ready:', e.message); send(ctx.res, 503, { ok: false }); }
      return true;
    }
    return false;
  };
}

module.exports = { createHealth, READY_TIMEOUT_MS };
