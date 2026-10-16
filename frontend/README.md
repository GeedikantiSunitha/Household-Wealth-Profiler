# frontend: front end

The screens advisers use.

`src/` holds the screens (moved here as `public/` in step B12, renamed in Phase 6). In development the server sends these files to the browser as they are, and
`/core.js` comes from `packages/core`. The interface is made of standard browser modules under `src/js/`, starting at `js/main.js`;
the browser loads them directly, so the running app needs no build step. Steps B13 to B20 split the
original single app.js into these modules without changing behaviour.

Without a server, use the single-file build: `npm run build`, then open `dist/wealth-profiler.html`.
That build bundles the modules into the page with esbuild (a development-only tool; it is not in
the Docker image and never reaches users).

## Layout

| Path | Holds |
| --- | --- |
| `src/` | `index.html`, `styles.css`, `vendor/` (SheetJS 0.20.3, pinned by hash in `scripts/vendor.js`) |
| `src/js/main.js` | Start-up only: signs in or finds the server, then draws the first screen |
| `src/js/pages/` | One file per screen, the sign-in screens (`sign-in.js`), and `render.js`, which draws the screen on show |
| `src/js/components/` | Form fields, banners, the live-effect panel, the side rail, the top bar |
| `src/js/hooks/` | What pages share: the state (`state.js`), the store (`store.js`: autosave, edit conflicts, the save status), people and firm look-ups, and `io/` (Excel import and export with SheetJS loaded on demand, saving files to the device) |
| `src/js/services/api/` | The only code that calls the server: `client.js`, and `auth.js` for the sign-in |
| `src/js/events/` | Typing in the form, every button and link, the top-bar buttons (the shell, with `main.js`) |
| `src/js/lib/` | Page helpers, number and date formats |
| `src/js/content/` | Field help, "how this section is used" text, the balance sheet groups |

The layers run one direction: pages use components, hooks and services; components use hooks;
hooks use services; services use nothing above them; `lib/` and `content/` sit below everything.
`test/ci/web-layers.test.js` fails on an import that looks up, and on any `fetch` outside
`services/api/`.

## The build

`npm run build:web` (`scripts/build-web.js`) turns `src/` into `dist/`: `index.html`, `styles.css`, `vendor/` and
`core.js` (from `packages/core`) copied byte for byte, and `js/main.js` with everything it imports bundled and
minified by esbuild as ES modules, split at dynamic imports, with no inline code, so the content security policy
stays `script-src 'self'`. `dist/` is what `frontend/Dockerfile` serves; it is never committed. To check a build
the way the web tier serves it, point the server at it: `WEB_DIR=frontend/dist npm start`, or
`WEB_DIR=frontend/dist npm run screens`. `test/ci/web-build.test.js` proves the build changes the packaging only.

## Rules

- Calculations come from `packages/core`; screens only display them.
- Nothing secret is ever sent to the browser.
- Modules import from each other with relative paths ending in `.js`; nothing is global except
  what other scripts provide (`window.HWP` from core.js).
- A module that only registers listeners (`events/editing.js`, `events/toolbar.js`) must be imported
  for its effect (`import './events/editing.js'`): nothing else loads it.
- After any change here, `npm run screens` must report `SAME`, or `LOOK` with every difference
  explained (see `docs/checklists/screen-smoke.md`), and `npm run build` must still produce a working `dist/wealth-profiler.html`.
