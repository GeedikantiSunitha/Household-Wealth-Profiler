/* Typing in the form: reads the value, records the change (audit trail when there is no server), saves (autosave), checks the field, refreshes the card summary, the live-effect panel and the side rail. */
import { LS_USER, Store, logChange } from '../api/store.js';
import { VALIDATE, summary } from '../components/form.js';
import { refreshImpact } from '../components/impact.js';
import { esc } from '../lib/dom.js';
import { state } from '../state.js';
import { renderNav } from '../views/nav.js';
import { render } from '../views/render.js';

const H = window.HWP; const { SCHEMA, YN, fieldsOf } = H;

// Timers: the live-effect panel refreshes 120 ms after typing stops, the side rail 250 ms after
let impT;
export function parseVal(f,raw,el){if(f.t===YN)return el?el.checked:raw;if(f.t==='num'||f.t==='pct'||f.t==='int'){if(raw===''||raw==null)return '';const n=parseFloat(String(raw).replace(/[£,%\s]/g,''));return isFinite(n)?n:''}return raw}
let navT;
export function onEdit(e){const el=e.target;
  if(el.id==='whoIn'){Store.user=el.value.trim();try{localStorage.setItem(LS_USER,Store.user)}catch(x){}return}
  if(!el.dataset||!el.dataset.k)return;const {col,idx,k}=el.dataset;const s=SCHEMA[col];const f=fieldsOf(s).find(x=>x.k===k);
  if(el.dataset.scope==='firm'){const v=parseVal(f,el.value,el.type==='checkbox'?el:null);const F=Store.firm.settings;const rec=s.single?F[col]:F[col][+idx];if(rec[k]===v)return;rec[k]=v;Store.touchFirm();
    if(!s.single){const card=document.querySelector(`[data-card="${col}:${idx}"]`);if(card){const [t,meta,val]=summary(col,rec);card.querySelector('.sum').innerHTML=`<b>${esc(t)}</b><span class="meta">${esc(meta)}</span>`;card.querySelector('.val').textContent=val}}return}
  const v=parseVal(f,el.value,el.type==='checkbox'?el:null);const rec=s.single?state.S[col]:state.S[col][+idx];const old=rec[k];if(old===v)return;rec[k]=v;
  logChange(s.single?`${col}.${k}`:`${col}[${idx}].${k}`,old,v);Store.touch();
  clearTimeout(impT);impT=setTimeout(()=>refreshImpact(`${s.title}: ${f.l}`,f),120);
  if(VALIDATE[k]){const msg=VALIDATE[k](v);const h=document.getElementById(el.id+'-h');el.setAttribute('aria-invalid',msg?'true':'false');if(h){h.textContent=msg||f.h||'';h.className='hint'+(msg?' err':'')}}
  if(!s.single){const card=document.querySelector(`[data-card="${col}:${idx}"]`);if(card){const [t,meta,val]=summary(col,rec);card.querySelector('.sum').innerHTML=`<b>${esc(t)}</b><span class="meta">${esc(meta)}</span>`;card.querySelector('.val').textContent=val}}
  clearTimeout(navT);navT=setTimeout(renderNav,250);
  if(col==='members'&&k==='role'&&e.type==='change')render();
  if(col==='rtq'&&e.type==='change'){applyRtq(rec);render()}
  if(col==='scen'&&e.type==='change'){state.OPEN.add('scen:settings');render()}
}
document.addEventListener('input',onEdit);
document.addEventListener('change',onEdit);
export function applyRtq(q){const r=H.rtqResult(q);if(!r)return;const m=state.S.members.find(x=>x.ref===q.owner);if(!m)return;const i=state.S.members.indexOf(m);
  for(const [k,v] of Object.entries(r))if(String(m[k])!==String(v)){logChange(`members[${i}].${k}`,m[k],v);m[k]=v}Store.touch()}
