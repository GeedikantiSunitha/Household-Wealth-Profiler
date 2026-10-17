// Waiting for a test server (server.js spawned by a test) to answer. Start-up applies migrations
// and may queue behind other test files migrating the same scratch database, so under a full-suite
// load it can take well over the few seconds a fixed poll count allows. The wait is bounded by
// time; a process that exits is reported at once with the last line it wrote.
'use strict';

async function waitForServer(proc, base, ms = 60000) {
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error(`server exited with code ${proc.exitCode}: ${err.trim().split('\n').pop() || '(nothing on stderr)'}`);
    try { if ((await fetch(base + '/healthz')).ok) return; } catch (e) { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not answer within ${ms / 1000} s: ${err.trim().split('\n').pop() || '(nothing on stderr)'}`);
}

module.exports = { waitForServer };
