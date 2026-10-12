#!/usr/bin/env node
/* The spreadsheet library (SheetJS) is served by the app itself from apps/web/public/vendor/,
   never from a CDN, so the Content Security Policy allows scripts from this server only. The copy
   is pinned by version and sha256: this command downloads it again from SheetJS and refuses to
   write anything whose hash differs. To upgrade, change the version, URL and hash here, run
   `npm run vendor`, and commit the result; test/ci/guards.test.js checks the committed file. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const XLSX = {
  version: '0.20.3',
  sha256: 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41',
  url: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  licenceUrl: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE',
};
const DIR = path.join(__dirname, '..', 'apps', 'web', 'public', 'vendor');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Whether the file at `file` is exactly the pinned library
function verify(file) {
  if (!fs.existsSync(file)) return { ok: false, sha256: '' };
  const h = sha256(fs.readFileSync(file));
  return { ok: h === XLSX.sha256, sha256: h };
}

async function vendor({ dir = DIR, fetch = globalThis.fetch } = {}) {
  const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const lib = await get(XLSX.url);
  const h = sha256(lib);
  if (h !== XLSX.sha256) throw new Error(`The download's sha256 is ${h}, expected ${XLSX.sha256}. Nothing was written.`);
  const licence = await get(XLSX.licenceUrl);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'xlsx.full.min.js'), lib);
  fs.writeFileSync(path.join(dir, 'LICENSE-xlsx.txt'), licence);
  return { sha256: h, file: path.join(dir, 'xlsx.full.min.js') };
}

module.exports = { XLSX, verify, vendor };

if (require.main === module) {
  vendor().then(r => console.log(`SheetJS ${XLSX.version} written to ${r.file} (sha256 ${r.sha256})`), e => { console.error(e.message); process.exit(1); });
}
