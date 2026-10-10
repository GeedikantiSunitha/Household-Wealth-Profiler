#!/usr/bin/env node
// Builds single-file versions of the app (no server needed):
//   dist/wealth-profiler.html  full page you can open from disk or host anywhere
//   dist/artifact.html         page fragment for a Claude artifact
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, 'apps', 'web', 'public', f), 'utf8');
const readCore = () => fs.readFileSync(path.join(root, 'packages', 'core', 'core.js'), 'utf8');
const html = read('index.html');
const css = read('styles.css');
// Escape closing tags so inlined code cannot end its own <script> block early
const safe = js => js.replace(/<\/script/gi, '<\\/script');
// The interface is browser modules (js/main.js and what it imports): bundle them into one ordinary
// script, since a single file cannot load modules. esbuild is a development dependency only.
function bundle(entry) {
  let esbuild;
  try { esbuild = require('esbuild'); } catch (e) { console.error('npm run build needs the development packages. Run: npm install'); process.exit(1); }
  const out = esbuild.buildSync({ entryPoints: [path.join(root, 'apps', 'web', 'public', entry)], bundle: true, format: 'iife', write: false, charset: 'utf8', logLevel: 'warning' });
  return out.outputFiles[0].text;
}
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script src="(config|cloud)\.js"><\/script>\n?/g, '') // the single file has no server or cloud sign-in
  .replace('<script src="core.js"></script>', () => `<script>\n${safe(readCore())}\n</script>`)
  .replace('<script type="module" src="js/main.js"></script>', () => `<script>\n${safe(bundle('js/main.js'))}\n</script>`);
const fonts = html.match(/<link rel="preconnect"[^>]*>\s*<link rel="stylesheet" href="https:\/\/fonts[^>]*>/)[0];
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const head = html.slice(0, html.indexOf('</head>')).replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`);
fs.writeFileSync(path.join(root, 'dist', 'wealth-profiler.html'), `${head}</head>\n<body>${body}</body>\n</html>\n`);
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), `<title>Household Wealth Profiler</title>\n${fonts}\n<style>\n${css}\n</style>\n${body.trim()}\n`);
console.log('Built dist/wealth-profiler.html and dist/artifact.html');
