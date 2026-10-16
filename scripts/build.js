#!/usr/bin/env node
// Builds the single-file demo version of the app (no server needed):
//   dist/wealth-profiler.html  a page you can open from disk. Data stays in that browser, so it is
//                              for demonstrations only, never client data.
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
  // Marks the page as the standalone demo: the only version allowed to keep data in the browser
  .replace('<script src="core.js"></script>', () => `<script>window.HWP_STANDALONE=true;</script>\n<script>\n${safe(readCore())}\n</script>`)
  .replace('<script type="module" src="js/main.js"></script>', () => `<script>\n${safe(bundle('js/main.js'))}\n</script>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const head = html.slice(0, html.indexOf('</head>')).replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`);
fs.writeFileSync(path.join(root, 'dist', 'wealth-profiler.html'), `${head}</head>\n<body>${body}</body>\n</html>\n`);
console.log('Built dist/wealth-profiler.html');
