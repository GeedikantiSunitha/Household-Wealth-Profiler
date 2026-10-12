/* Firm settings screen: firm details, team and providers, edited like a household's cards and saved for the whole firm. */
import { Store } from '../api/store.js';
import { bannerHTML } from '../components/banner.js';
import { fieldsBlock, summary } from '../components/form.js';
import { esc } from '../lib/dom.js';
import { state } from '../state.js';

const H = window.HWP; const { SCHEMA } = H;

export function firmCards(key){const s=SCHEMA[key];const L=Store.firm.settings[key];
  let h=`<div class="sec-head" style="margin-top:28px"><div><h2 style="font-size:20px">${esc(s.title)}</h2><p>${esc(s.desc)}</p></div><div class="addrow"><button class="btn" type="button" data-act="toggleAll" data-col="${key}">Expand all</button><button class="btn primary" type="button" data-act="add" data-col="${key}">Add ${esc(s.item)}</button></div></div>`;
  if(!L.length)h+=`<div class="empty">None yet.</div>`;
  L.forEach((r,i)=>{const [t,meta,v]=summary(key,r);const open=state.OPEN.has(key+':'+i);
    const extra=key==='funds'?`<div class="addrow" style="margin:0 0 14px"><button class="btn" type="button" data-act="fundImport" data-idx="${i}">Import prices from CSV</button>${Store.mode==='server'&&r.ticker?`<button class="btn" type="button" data-act="fundFetch" data-idx="${i}">Fetch prices for ${esc(r.ticker)}</button>`:''}<span class="muted" style="align-self:center">${esc(H.seriesLabel(r.prices)||'No prices yet')}</span></div>`:'';
    h+=`<div class="card" data-open="${open}" data-card="${key}:${i}"><div class="card-h" data-act="toggle" data-col="${key}" data-idx="${i}" role="button" tabindex="0" aria-expanded="${open}"><span class="chev">▸</span><span class="sum"><b>${esc(t)}</b><span class="meta">${esc(meta)}</span></span><span class="val">${esc(v)}</span><button class="btn ghost" type="button" data-act="del" data-col="${key}" data-idx="${i}">Remove</button></div><div class="card-b">${extra}${fieldsBlock(key,i,r)}</div></div>`});
  return h}
export function renderFirmSettings(){const F=Store.firm.settings;
  let h=`<div class="sec-head"><div><h2>Firm settings</h2><p>Shared by every household: the firm\u2019s details for letters, the team that tasks are assigned to, and the providers letters of authority go to.${Store.mode==='server'?' Changes are saved for everyone and recorded in the firm audit trail.':' Saved in this browser only.'}</p></div></div>`+bannerHTML(false);
  h+=`<div class="card" data-open="true"><div class="card-b" style="border-top:0">${fieldsBlock('firm',0,F.firm)}</div></div>`;
  return h+firmCards('team')+firmCards('providers')+firmCards('funds')}
