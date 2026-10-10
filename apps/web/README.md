# apps/web: front end

The screens advisers use.

**Fills in step B12** (the files in `public/` move here unchanged) **and steps B13 to B20**
(`app.js` is split into modules, one group per step, safest first).

## Planned layout

| Folder | Holds |
| --- | --- |
| `public/` | `index.html`, `styles.css`, `config.js` (non-secret settings only), `vendor/` |
| `src/main.js` | Start-up |
| `src/state/` | The open household, autosave, edit conflicts (shared by every screen) |
| `src/api/` | The only code that calls the backend |
| `src/auth/` | Sign-in screens |
| `src/content/` | Field help and "how this section is used" text |
| `src/components/` | Form fields, banners, the live-effect panel |
| `src/views/` | One file per screen |
| `src/events/` | Editing and button handling |
| `src/lib/` | Formatting, Excel and JSON import/export |

## Rules

- Calculations come from `packages/core`; screens only display them.
- Nothing secret is ever sent to the browser.
- After each step, `npm run screens` must report `SAME` (see `docs/checklists/screen-smoke.md`).
