/* Every input section: its how-it-is-used panel, live effect, and the form or list of cards. */
import { bannerHTML } from '../components/banner.js';
import { fieldsBlock, summary } from '../components/form.js';
import { howHTML } from '../components/how.js';
import { RECORD_ONLY, impactHTML } from '../components/impact.js';
import { rtqPanel } from '../components/rtq.js';
import { esc } from '../lib/dom.js';
import { state } from '../hooks/state.js';

const H = window.HWP; const { SCHEMA } = H;

export function renderInput(key){
  const s=SCHEMA[key];let h=`<div class="sec-head"><div><h2>${esc(s.title)}</h2><p>${esc(s.desc||'')}</p></div>`;
  if(!s.single)h+=`<div class="addrow"><button class="btn" type="button" data-act="toggleAll" data-col="${key}">Expand all</button><button class="btn primary" type="button" data-act="add" data-col="${key}">Add ${esc(s.item)}</button></div>`;
  h+=`</div>`+bannerHTML()+(RECORD_ONLY.has(key)?'':impactHTML())+howHTML(key);
  if(s.single){h+=`<div class="card" data-open="true"><div class="card-b" style="border-top:0">${fieldsBlock(key,0,state.S[key])}</div></div>`;
    if(key==='assumptions')h+=`<p class="note">Figures reflect the 2026/27 tax year as announced. From April 2027 unused pensions fall into the estate for IHT, and savings and property income rates rise by 2 points; update these inputs when they take effect.</p><div class="addrow"><button class="btn" type="button" data-act="resetAssump">Restore defaults</button></div>`;
    if(key==='compliance')h+=`<div class="addrow"><button class="btn" type="button" data-nav="kyc">See onboarding status</button></div>`;
    return h}
  if(!state.S[key].length)h+=`<div class="empty">Nothing recorded yet. Use “Add ${esc(s.item)}” or import an Excel file.</div>`;
  if(key==='rtq')h+=rtqPanel();
  if(key==='loas'&&state.S.loas.length)h+=`<p class="note" style="margin:0 0 12px">Open a letter, check the details, then use <b>Letter</b> to print it or save it as PDF for the client to sign.</p>`;
  state.S[key].forEach((r,i)=>{const [t,meta,v]=summary(key,r);const open=state.OPEN.has(key+':'+i);
    h+=`<div class="card" data-open="${open}" data-card="${key}:${i}"><div class="card-h" data-act="toggle" data-col="${key}" data-idx="${i}" role="button" tabindex="0" aria-expanded="${open}"><span class="chev">▸</span><span class="sum"><b>${esc(t)}</b><span class="meta">${esc(meta)}</span></span><span class="val">${esc(v)}</span>${key==='loas'?`<button class="btn" type="button" data-act="loaLetter" data-idx="${i}">Letter</button>`:''}<button class="btn ghost" type="button" data-act="del" data-col="${key}" data-idx="${i}">Remove</button></div><div class="card-b">${fieldsBlock(key,i,r)}</div></div>`});
  return h;
}
