/* The app's own files from frontend/src (or WEB_DIR: a built frontend/dist), plus /core.js from packages/core (the one copy of the rules).
   Nothing outside that folder can be read: such paths, like missing files, are 404. A path whose
   percent-encoding is broken is 400. */
'use strict';
const fsp = require('fs').promises;
const path = require('path');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function createStatic({ publicDir, coreFile, send }) {
  return async function serveStatic(req, res, pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
    const rel = pathname === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const file = rel === 'core.js' ? coreFile : path.resolve(publicDir, rel);
    if (file !== coreFile && !file.startsWith(publicDir + path.sep)) return send(res, 404, { error: 'Not found' });
    try {
      const data = await fsp.readFile(file);
      send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    } catch (e) { send(res, 404, { error: 'Not found' }); }
  };
}

/* The public landing page (frontend/src/landing.html at /welcome) and its images (site/*.png): marketing only,
   no client data, so they are served before sign-in in every sign-in mode. Only these exact paths:
   /site/ takes a plain file name, never a sub-folder or an encoded path. */
const PUBLIC_PAGES = new Set(['/welcome', '/landing.html']);
const isPublicPage = p => PUBLIC_PAGES.has(p) || /^\/site\/[\w-]+\.png$/.test(p);
const publicFile = p => (p === '/welcome' ? '/landing.html' : p);

module.exports = { createStatic, MIME, isPublicPage, publicFile };
