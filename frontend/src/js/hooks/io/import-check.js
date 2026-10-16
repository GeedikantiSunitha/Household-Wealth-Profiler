/* Dropdown values an imported file carries that are not among the options the form offers. The
   server refuses such a value, so they are listed before anything is applied or saved, and the
   file can be fixed in one pass. Pure: takes the core module and a normalised household state. */

// [{ sheet, entry, field, value }]: entry is the record's position within its sheet (1 = first), null for a single section
export function unknownDropdowns(H, ns) {
  const out = [];
  const check = (key, row, entry) => {
    if (!row || typeof row !== 'object') return;
    for (const f of H.fieldsOf(H.SCHEMA[key])) {
      if (f.t !== 'sel') continue;
      const v = row[f.k];
      if (v === undefined || v === null || v === '') continue;
      if (!H.optList(f.o).some(([val]) => String(val) === String(v))) out.push({ sheet: H.SCHEMA[key].sheet, entry, field: f.l, value: String(v) });
    }
  };
  for (const key of H.SINGLES) check(key, ns[key], null);
  for (const key of H.COLS) (Array.isArray(ns[key]) ? ns[key] : []).forEach((r, i) => check(key, r, i + 1));
  return out;
}

// One line per problem, for the banner: Members entry 2, Role: "Wizard"
export const describeUnknown = u => `${u.sheet}${u.entry ? ` entry ${u.entry}` : ''}, ${u.field}: "${u.value}"`;
