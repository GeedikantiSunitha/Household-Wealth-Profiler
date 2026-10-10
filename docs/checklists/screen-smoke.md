# Screen check

Run after every restructuring step that touches the front end or how files are served
(Stage B steps B2, B10, B12 to B20). The app must look and behave exactly as it did at the
`baseline-before-restructure` tag.

## 1. Automatic part (2 minutes)

```sh
npm run screens
```

Needs Chrome or Edge installed (set `CHROME` to its path if it is somewhere unusual). It starts
the app on a temporary data folder with a demo login, so it never touches `data-dev` or a
database, and fixes the browser clock at 2026-10-10 so the sample household always shows the
same dates.

It fails if any of these goes wrong:

| Check | Expected |
| --- | --- |
| Sign-in | The client list opens, empty, with "Signed in as demo" |
| New from sample | Creates "Harrington household" |
| Side rail | 27 sections in this order: household, members, income, expenses, goals, accounts, db, property, other, liabilities, protection, assumptions, compliance, kyc, audit, contacts, actions, complaints, reviews, mandate, models, drift, bs, tax, risk, checks, guide |
| Rules on screen | Header shows "KYC and AML"; KYC in the rail shows "2 open" |
| Every section | Renders without a script error, and without "undefined" or "NaN" on screen |
| Autosave | Typing a change ends with "All changes saved" |
| Reload | The change is still there in the client list and in the form |
| Reviews due | The firm-wide diary renders |
| Edit conflict | A save after someone else's shows "Someone else saved this household…" and "Not saved: newer version exists"; "Reload their version" loads theirs |
| Phone width | Household, balance sheet and KYC captured at 390 px (page width recorded in the report) |

Screenshots and `report.txt` go to `docs/checklists/screens/<date-time>/`; that folder is
git-ignored. The report ends with one of:

- `SAME`: every screen is byte-identical to the baseline. Done.
- `LOOK`: lists the screens that differ. Open each next to its baseline file and confirm the
  difference is expected. Any unexpected difference means the step broke something.

The audit trail and the client list show the server's real save times, so they are not compared.

**Baseline:** made once, before the first restructuring step, with
`npm run screens -- baseline`. Do not remake it during Stage B; it is the reference.

## 2. By hand (5 minutes)

Use `npm run dev` (demo / demo, data in `./data-dev`) at http://localhost:8080.

1. **Excel template:** "Excel template" downloads `household-data-template.xlsx`; it opens in Excel with one sheet per section.
2. **Excel export:** open a household, "Export Excel" downloads `<date>-profile.xlsx` with the household's figures.
3. **Excel import:** "Import Excel / JSON" with that file loads the same figures (spot-check People, Income, balance sheet total).
4. **JSON round trip:** "Export JSON", then import that file: same household, same balance sheet total.
5. **Add and remove:** in People, "Add person", then remove it; the "Removed … Undo" banner appears and Undo brings it back.
6. **Assumptions reset:** change a figure in Assumptions, then "Restore defaults"; the toast says 2026/27 defaults.
7. **PostgreSQL mode:** `npm start` (settings from `.env`): the start-up line says `data in PostgreSQL …`, sign in, open a household, change a field, see "All changes saved".
8. **Browser-only mode:** run `npm run build` and open `dist/wealth-profiler.html` straight from the disk (no server; it has the rules built in): the sample loads, the header shows "Working as", and the save state says "Saved in this browser only".

Excel needs the internet (SheetJS loads from cdnjs) unless `scripts/fetch-xlsx.sh` has been run.

## 3. Record the result

In the commit message for the step: `Screen check: automatic SAME (or LOOK: <screens>, expected because …); by hand 1-8 OK`.
