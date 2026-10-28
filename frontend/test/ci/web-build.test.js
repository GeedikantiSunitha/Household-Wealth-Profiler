// scripts/build-web.js: frontend/src -> dist. The build changes the packaging of the screens, never
// their content: the page and the stylesheet are copied byte for byte, core.js is the one in
// packages/core, the vendored libraries are the pinned ones, and the bundle is plain ES modules
// with no inline code (the content security policy allows scripts from the site only).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'frontend', 'src');

test('the build copies the page, the styles, the libraries and core.js byte for byte, and bundles js/main.js', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-web-build-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.js'), out], { stdio: 'pipe' });
    for (const f of ['index.html', 'styles.css', 'welcome.css', 'runtime-config.js']) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(SRC, f))), `${f} is copied unchanged`);
    assert.ok(fs.readFileSync(path.join(out, 'core.js')).equals(fs.readFileSync(path.join(ROOT, 'packages', 'core', 'core.js'))), 'core.js is the one copy of the rules');
    for (const f of fs.readdirSync(path.join(SRC, 'vendor'))) assert.ok(fs.readFileSync(path.join(out, 'vendor', f)).equals(fs.readFileSync(path.join(SRC, 'vendor', f))), `vendor/${f} is the pinned file`);
    const main = fs.readFileSync(path.join(out, 'js', 'main.js'), 'utf8');
    assert.ok(main.length > 10000, 'the bundle holds the screens');
    assert.doesNotMatch(main, /from"\.\.\//, 'nothing is imported from outside the bundle');
    assert.ok(!fs.existsSync(path.join(out, 'js', 'pages')), 'the source tree is not copied: the bundle replaces it');
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/, 'the page loads the bundle by the same name');
    assert.doesNotMatch(html, /<script>/, 'no inline script');
    assert.match(html, /<html lang="en-GB" class="booting">/, 'the page starts hidden, so no frame flashes before the app knows who is here');
    const css = fs.readFileSync(path.join(out, 'styles.css'), 'utf8');
    assert.match(css, /html\.booting body>header\.top,html\.booting body>\.shell,html\.booting body>\.foot\{visibility:hidden;animation:hwp-show 0s 8s forwards\}/, 'hidden while starting, and shown after 8 s whatever happens');
    assert.match(html, /<link rel="stylesheet" href="welcome\.css">/, 'the landing page\'s styles load with the app');
    for (const f of fs.readdirSync(path.join(SRC, 'site'))) assert.ok(fs.readFileSync(path.join(out, 'site', f)).equals(fs.readFileSync(path.join(SRC, 'site', f))), `site/${f}, a landing page screenshot, is copied`);
    assert.ok(!fs.existsSync(path.join(out, 'landing.html')), 'one page: the landing page is part of the app, not a second address');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
