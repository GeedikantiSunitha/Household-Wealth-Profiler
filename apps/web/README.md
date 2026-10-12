# apps/web: front end

The screens advisers use.

`public/` moved here unchanged in step B12; the server sends these files to the browser, and
`/core.js` comes from `packages/core`. The interface is made of standard browser modules under `public/js/`, starting at `js/main.js`;
the browser loads them directly, so the running app needs no build step. Steps B13 to B20 split the
original single app.js into these modules without changing behaviour.

Without a server, use the single-file build: `npm run build`, then open `dist/wealth-profiler.html`.
That build bundles the modules into the page with esbuild (a development-only tool; it is not in
the Docker image and never reaches users).

## Layout

| Path | Holds |
| --- | --- |
| `public/` | `index.html`, `styles.css`, `config.js` (non-secret settings only), `cloud.js`, `vendor/` |
| `public/js/main.js` | Start-up only: signs in or finds the server, then draws the first screen |
| `public/js/state.js` | The open household, the current screen, open sections, the banner (shared by every screen) |
| `public/js/api/store.js` | The only code that calls the backend: autosave, edit conflicts, the save status |
| `public/js/content/` | Field help and "how this section is used" text |
| `public/js/components/` | Form fields, banners, the live-effect panel |
| `public/js/views/` | One file per screen |
| `public/js/events/` | Typing in the form, every button and link, the top-bar buttons |
| `public/js/lib/` | Page helpers, number and date formats, people in the household |
| `public/js/io/` | Excel import and export (SheetJS, loaded on demand), saving files to the device |

## Rules

- Calculations come from `packages/core`; screens only display them.
- Nothing secret is ever sent to the browser.
- Modules import from each other with relative paths ending in `.js`; nothing is global except
  what other scripts provide (`window.HWP` from core.js, `window.HWP_CONFIG`, `window.HWPCloud`).
- A module that only registers listeners (`events/editing.js`, `events/toolbar.js`) must be imported
  for its effect (`import './events/editing.js'`): nothing else loads it.
- After any change here, `npm run screens` must report `SAME`, or `LOOK` with every difference
  explained (see `docs/checklists/screen-smoke.md`), and `npm run build` must still produce a working `dist/wealth-profiler.html`.
