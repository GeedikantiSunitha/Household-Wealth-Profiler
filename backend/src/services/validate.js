/* Field rules for what the API stores (step 1.6). The browser form keeps most bad values out, but
   a request made outside the app can send anything, and the engine turns bad values into 0, false
   or null, so the figures on screen would be wrong rather than the save refused. These rules run
   on the normalised state (only schema keys, primitives only), so what is checked is exactly what
   would be stored. The rules come from the schema in packages/core, which is not changed:
     text, team, model, provider   text of at most 200 characters, no control characters
     area                          notes of at most 5,000 characters; line breaks allowed
     bool                          true or false ("true"/"false" from older saves become booleans)
     num                           blank or a finite number within ±1,000,000,000,000
     int                           blank or a whole number within ±1,000,000
     pct                           blank or a number between -1,000 and 1,000
     date                          blank or a real calendar date YYYY-MM-DD, 1900 to 2200
     sel                           blank or one of the listed option values (strict)
     owner, member                 a short code of at most 40 characters (format only)
     series                        blank or the monthly price format core.js writes, at most 2,000 points
   A numeric string in a number field is stored as a number; an option value that looks like a
   number is stored as the option's text. Each collection holds at most 500 rows (people 50). The
   client reference is capped at 50 characters because it feeds the blind index. Every problem is
   reported as { field, message }: the field path and the rule, never the submitted value. */
'use strict';

const LIMITS = Object.freeze({ text: 200, area: 5000, reference: 50, code: 40, rows: 500, members: 50, seriesPoints: 2000, num: 1e12, int: 1e6, pct: 1000 });

const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const CONTROL = /[\u0000-\u001F\u007F]|\p{Surrogate}/u; // \p{Surrogate} matches only a lone half
const CONTROL_IN_NOTES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\p{Surrogate}/u; // tab, newline and return allowed
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const SERIES_POINT = /^\d{4}-\d{2}:[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i;

function textRule(v, max, notes) {
  if (typeof v !== 'string') return 'must be text';
  if (v.length > max) return `must be at most ${fmt(max)} characters`;
  if ((notes ? CONTROL_IN_NOTES : CONTROL).test(v)) return 'must not contain control characters';
  return null;
}
// A number from a number or a numeric string (the browser strips £, commas, % and spaces too); null when it is not one
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[£,%\s]/g, '');
  return NUMBER.test(t) ? Number(t) : null;
}
function dateRule(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'must be a date (YYYY-MM-DD)';
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return 'must be a date (YYYY-MM-DD)';
  const y = +v.slice(0, 4);
  return y < 1900 || y > 2200 ? 'must be a date between 1900 and 2200' : null;
}
function seriesRule(v) {
  const bad = 'must be a monthly price series of at most 2,000 points';
  if (typeof v !== 'string') return bad;
  const points = v.split(';');
  if (points.length > LIMITS.seriesPoints || !points.every(p => SERIES_POINT.test(p))) return bad;
  return null;
}

// Checks one field; returns the rule broken, or null. May replace row[key] with the canonical value.
function checkField(H, f, row) {
  const v = row[f.k];
  if (v === undefined || v === null) return null;
  const t = f.t;
  if (t === H.YN) {
    if (v === true || v === false) return null;
    if (v === 'true' || v === 'false') { row[f.k] = v === 'true'; return null; }
    return 'must be yes or no';
  }
  if (t === 'num' || t === 'int' || t === 'pct') {
    if (v === '') return null;
    const n = toNumber(v);
    if (t === 'pct') { if (n === null || n < -LIMITS.pct || n > LIMITS.pct) return `must be a number between -${fmt(LIMITS.pct)} and ${fmt(LIMITS.pct)}`; row[f.k] = n; return null; }
    if (n === null) return t === 'int' ? 'must be a whole number' : 'must be a number';
    if (t === 'int' && !Number.isInteger(n)) return 'must be a whole number';
    const lim = t === 'int' ? LIMITS.int : LIMITS.num;
    if (n < -lim || n > lim) return `must be between -${fmt(lim)} and ${fmt(lim)}`;
    row[f.k] = n;
    return null;
  }
  if (t === 'date') return v === '' ? null : dateRule(v);
  if (t === 'sel') {
    if (v === '') return null;
    const hit = H.optList(f.o).find(([val]) => String(val) === String(v));
    if (!hit) return 'must be one of the listed options';
    row[f.k] = String(hit[0]);
    return null;
  }
  if (t === 'owner' || t === 'member') return textRule(v, LIMITS.code, false);
  if (t === 'series') return v === '' ? null : seriesRule(v);
  if (t === 'area') return textRule(v, LIMITS.area, true);
  return textRule(v, LIMITS.text, false); // text, team, model, provider
}

function checkRecord(H, s, singles, cols, { referenceKey } = {}) {
  const errors = [];
  const fieldsOf = key => H.fieldsOf(H.SCHEMA[key]);
  for (const key of singles) {
    const row = s[key];
    if (!row || typeof row !== 'object') { errors.push({ field: key, message: 'must be a section' }); continue; }
    for (const f of fieldsOf(key)) {
      const m = key === referenceKey && f.k === 'reference' && typeof row[f.k] === 'string' && row[f.k].length > LIMITS.reference
        ? `must be at most ${fmt(LIMITS.reference)} characters` : checkField(H, f, row);
      if (m) errors.push({ field: `${key}.${f.k}`, message: m });
    }
  }
  for (const key of cols) {
    const rows = s[key];
    if (!Array.isArray(rows)) { errors.push({ field: key, message: 'must be a list' }); continue; }
    const cap = key === 'members' ? LIMITS.members : LIMITS.rows;
    if (rows.length > cap) errors.push({ field: key, message: `must have at most ${fmt(cap)} rows` });
    rows.slice(0, cap).forEach((row, i) => {
      if (!row || typeof row !== 'object') { errors.push({ field: `${key}[${i}]`, message: 'must be a row' }); return; }
      for (const f of fieldsOf(key)) { const m = checkField(H, f, row); if (m) errors.push({ field: `${key}[${i}].${f.k}`, message: m }); }
    });
  }
  return errors;
}

// The problems with a normalised household state (empty when it may be stored); canonicalises in place
const validateHousehold = (H, s) => checkRecord(H, s, H.SINGLES, H.COLS, { referenceKey: 'household' });
// The same for normalised firm settings
const validateFirm = (H, settings) => checkRecord(H, settings, H.FIRM_SINGLES, H.FIRM_COLS);

// The error the API answers with: 400, code invalid_field, the first problem as the message and up to twenty listed
const MAX_REPORTED = 20;
function invalidError(what, errors) {
  const first = errors[0];
  return Object.assign(new Error(`${what}: ${first.field} ${first.message}`), { status: 400, code: 'invalid_field', errors: errors.slice(0, MAX_REPORTED) });
}

module.exports = { validateHousehold, validateFirm, invalidError, LIMITS };
