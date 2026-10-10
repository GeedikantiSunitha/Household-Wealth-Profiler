#!/usr/bin/env node
// Builds the Supabase edition's front end into dist/web, ready for any static host
// (Cloudflare Pages, Netlify). Reads SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (the anon or
// publishable key; never the secret key). Optional: REQUIRE_MFA=0, FIRM_HINT.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'web');
const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key) { console.error('Set SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_PUBLISHABLE_KEY'); process.exit(1); }
if (/^sb_secret_/.test(key) || /service_role/.test(Buffer.from(key.split('.')[1] || '', 'base64').toString())) { console.error('That is the secret key. Use the publishable (anon) key.'); process.exit(1); }

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'app.js', 'cloud.js', 'styles.css']) fs.copyFileSync(path.join(root, 'apps', 'web', 'public', f), path.join(out, f));
fs.copyFileSync(path.join(root, 'packages', 'core', 'core.js'), path.join(out, 'core.js'));
if (fs.existsSync(path.join(root, 'apps', 'web', 'public', 'vendor'))) fs.cpSync(path.join(root, 'apps', 'web', 'public', 'vendor'), path.join(out, 'vendor'), { recursive: true });
const config = { supabaseUrl: url, supabaseKey: key, requireMfa: process.env.REQUIRE_MFA !== '0', firmHint: process.env.FIRM_HINT || '' };
fs.writeFileSync(path.join(out, 'config.js'), `window.HWP_CONFIG=${JSON.stringify(config)};\n`);

const csp = ["default-src 'self'", "script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", `connect-src 'self' ${url}`, "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"].join('; ');
// _headers is read by Cloudflare Pages and Netlify
fs.writeFileSync(path.join(out, '_headers'), `/*
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
  Cache-Control: no-cache
`);
console.log(`Built dist/web for ${url}`);
