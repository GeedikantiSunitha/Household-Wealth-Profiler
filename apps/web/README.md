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
| `public/` | `index.html`, `styles.css`, `vendor/` (SheetJS 0.20.3, pinned by hash in `scripts/vendor.js`) |
| `public/js/main.js` | Start-up only: signs in or finds the server, then draws the first screen |
| `public/js/pages/` | One file per screen, the sign-in screens (`sign-in.js`), and `render.js`, which draws the screen on show |
| `public/js/components/` | Form fields, banners, the live-effect panel, the side rail, the top bar |
| `public/js/hooks/` | What pages share: the state (`state.js`), the store (`store.js`: autosave, edit conflicts, the save status), people and firm look-ups, and `io/` (Excel import and export with SheetJS loaded on demand, saving files to the device) |
| `public/js/services/api/` | The only code that calls the server: `client.js`, and `auth.js` for the sign-in |
| `public/js/events/` | Typing in the form, every button and link, the top-bar buttons (the shell, with `main.js`) |
| `public/js/lib/` | Page helpers, number and date formats |
| `public/js/content/` | Field help, "how this section is used" text, the balance sheet groups |

The layers run one direction: pages use components, hooks and services; components use hooks;
hooks use services; services use nothing above them; `lib/` and `content/` sit below everything.
`test/ci/web-layers.test.js` fails on an import that looks up, and on any `fetch` outside
`services/api/`.

## Rules

- Calculations come from `packages/core`; screens only display them.
- Nothing secret is ever sent to the browser.
- Modules import from each other with relative paths ending in `.js`; nothing is global except
  what other scripts provide (`window.HWP` from core.js).
- A module that only registers listeners (`events/editing.js`, `events/toolbar.js`) must be imported
  for its effect (`import './events/editing.js'`): nothing else loads it.
- After any change here, `npm run screens` must report `SAME`, or `LOOK` with every difference
  explained (see `docs/checklists/screen-smoke.md`), and `npm run build` must still produce a working `dist/wealth-profiler.html`.
