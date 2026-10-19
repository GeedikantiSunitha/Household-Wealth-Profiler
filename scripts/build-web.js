#!/usr/bin/env node
/* Builds the front end: frontend/src -> frontend/dist, ready for the web tier (frontend/Dockerfile)
   or any static host. The source is plain browser modules and runs as it is in development (the API
   serves frontend/src); this build bundles and minifies them for first-load speed, and copies
   everything else byte for byte:
     dist/index.html, dist/styles.css   as in src
     dist/js/main.js (+ chunks)         js/main.js and everything it imports, bundled by esbuild
                                        (ES modules, split at dynamic imports, no inline code, so
                                        the content security policy stays script-src 'self')
     dist/vendor/                       the pinned libraries, as in src
     dist/core.js                       packages/core/core.js, the one copy of the rules
   esbuild is a development dependency only; it never reaches users.
     node scripts/build-web.js [OUT_DIR]      default frontend/dist */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'frontend', 'src');
const out = path.resolve(process.argv[2] || path.join(root, 'frontend', 'dist'));

let esbuild;
try { esbuild = require('esbuild'); } catch (e) { console.error('npm run build:web needs the development packages. Run: npm install'); process.exit(1); }

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'js'), { recursive: true });
for (const f of ['index.html', 'styles.css', 'runtime-config.js']) fs.copyFileSync(path.join(src, f), path.join(out, f));
fs.cpSync(path.join(src, 'vendor'), path.join(out, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(root, 'packages', 'core', 'core.js'), path.join(out, 'core.js'));
const result = esbuild.buildSync({
  entryPoints: [path.join(src, 'js', 'main.js')],
  outdir: path.join(out, 'js'),
  bundle: true, format: 'esm', splitting: true, minify: true, charset: 'utf8',
  entryNames: '[name]', chunkNames: 'chunk-[hash]',
  logLevel: 'warning',
});
if (result.errors.length) process.exit(1);
const files = fs.readdirSync(path.join(out, 'js'));
console.log(`Built ${path.relative(root, out)}: js/${files.join(', js/')}, core.js, vendor/, index.html, styles.css`);
