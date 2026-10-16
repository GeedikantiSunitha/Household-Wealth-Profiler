/* Gate 1, parse-url: a request whose URL cannot be parsed is answered 400 "Bad request", never a
   server error. On success ctx.url and ctx.p (the pathname) are set for every later gate. */
'use strict';

function createParseUrl({ send }) {
  return function parseUrl(ctx) {
    try { ctx.url = new URL(ctx.req.url, 'http://localhost'); } catch (e) { send(ctx.res, 400, { error: 'Bad request' }); return true; }
    ctx.p = ctx.url.pathname;
    return false;
  };
}

module.exports = { createParseUrl };
