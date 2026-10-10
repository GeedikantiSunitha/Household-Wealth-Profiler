# apps/web: front end

The screens advisers use.

`public/` moved here unchanged in step B12; the server sends these files to the browser, and
`/core.js` comes from `packages/core`. Since step B13 the interface is made of standard browser
modules under `public/js/`, starting at `js/main.js`; the browser loads them directly, so the
running app needs no build step. **Steps B13 to B20** split the code into modules, one group per
step, safest first.

Without a server, use the single-file build: `npm run build`, then open `dist/wealth-profiler.html`.
That build bundles the modules into the page with esbuild (a development-only tool; it is not in
the Docker image and never reaches users).

## Layout (filled step by step)

| Path | Holds |
| --- | --- |
| `public/` | `index.html`, `styles.css`, `config.js` (non-secret settings only), `cloud.js`, `vendor/` |
| `public/js/main.js` | Start-up, and for now everything not yet moved out |
| `public/js/state.js` | The open household, the current screen, open sections, the banner (shared by every screen) |
| `public/js/api/` | The only code that calls the backend |
| `public/js/content/` | Field help and "how this section is used" text |
| `public/js/components/` | Form fields, banners, the live-effect panel |
| `public/js/views/` | One file per screen |
| `public/js/events/` | Editing and button handling |
| `public/js/lib/` | Formatting, Excel and JSON import/export |

## Rules

- Calculations come from `packages/core`; screens only display them.
- Nothing secret is ever sent to the browser.
- Modules import from each other with relative paths ending in `.js`; nothing is global except
  what other scripts provide (`window.HWP` from core.js, `window.HWP_CONFIG`, `window.HWPCloud`).
- After each step, `npm run screens` must report `SAME` (see `docs/checklists/screen-smoke.md`),
  and `npm run build` must still produce a working `dist/wealth-profiler.html`.
