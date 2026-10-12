/* Firm settings look-ups used across screens: which collections belong to the firm rather than the household, and the team and provider pick-lists. */
import { Store } from '../api/store.js';
import { state } from '../state.js';

const H = window.HWP; const { yes } = H;

export const FIRM_KEYS=new Set(['firm','team','providers']);
export const recs=col=>FIRM_KEYS.has(col)?Store.firm.settings[col]:state.S[col];
export function teamOptions(val){const t=((Store.firm.settings||{}).team||[]).filter(m=>m.name&&(yes(m.active)||m.name===val)).map(m=>[m.name,`${m.name}${m.role?' · '+m.role:''}`]);
  if(val&&!t.some(o=>o[0]===val))t.push([val,val+' (not in team list)']);return t}
export function providerOptions(val){const t=((Store.firm.settings||{}).providers||[]).filter(p=>p.name).map(p=>[p.name,p.name]);if(val&&!t.some(o=>o[0]===val))t.push([val,val]);return t}
