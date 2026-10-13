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
// The QR code library (qrcode-generator, MIT), used only to show the authenticator set-up code at enrolment
const QRCODE = {
  version: '1.4.4',
  sha256: '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780',
  url: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  licenceUrl: 'https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/master/LICENSE',
  file: 'qrcode.js', licenceFile: 'LICENSE-qrcode.txt', name: 'qrcode-generator',
};
Object.assign(XLSX, { file: 'xlsx.full.min.js', licenceFile: 'LICENSE-xlsx.txt', name: 'SheetJS' });
const LIBS = [XLSX, QRCODE];
const DIR = path.join(__dirname, '..', 'apps', 'web', 'public', 'vendor');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Whether the file at `file` is exactly the pinned library
function verify(file, lib = XLSX) {
  if (!fs.existsSync(file)) return { ok: false, sha256: '' };
  const h = sha256(fs.readFileSync(file));
  return { ok: h === lib.sha256, sha256: h };
}

// Downloads every pinned library; nothing is written unless every hash matches
async function vendor({ dir = DIR, fetch = globalThis.fetch } = {}) {
  const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const got = [];
  for (const lib of LIBS) {
    const bytes = await get(lib.url);
    const h = sha256(bytes);
    if (h !== lib.sha256) throw new Error(`${lib.name}: the download's sha256 is ${h}, expected ${lib.sha256}. Nothing was written.`);
    got.push({ lib, bytes, licence: await get(lib.licenceUrl), sha256: h });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const g of got) { fs.writeFileSync(path.join(dir, g.lib.file), g.bytes); fs.writeFileSync(path.join(dir, g.lib.licenceFile), g.licence); }
  return got.map(g => ({ sha256: g.sha256, file: path.join(dir, g.lib.file), name: g.lib.name, version: g.lib.version }));
}

module.exports = { XLSX, QRCODE, LIBS, verify, vendor };

if (require.main === module) {
  vendor().then(r => { for (const x of r) console.log(`${x.name} ${x.version} written to ${x.file} (sha256 ${x.sha256})`); }, e => { console.error(e.message); process.exit(1); });
}
