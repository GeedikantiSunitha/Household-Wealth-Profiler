/* Live effect of a section: headline figures compared with when the section was opened, updated as the adviser types. RECORD_ONLY sections (records, not inputs to the figures) show no panel. */
import { $, esc } from '../lib/dom.js';
import { gbpK, pct } from '../lib/format.js';
import { state } from '../state.js';

export const RECORD_ONLY=new Set(['contacts','actions','complaints','mandate','models','loas','rtq']);
export const sgn=n=>n>0?'+':'−';
export const DELTA={
  money:(a,b)=>{const d=b-a;return !isFinite(d)||Math.abs(d)<0.5?null:[sgn(d)+gbpK(Math.abs(d)),Math.sign(d)]},
  ratio:(a,b)=>{if(!isFinite(a)||!isFinite(b))return a===b?null:['changed',0];const d=b-a;return Math.abs(d)<0.005?null:[sgn(d)+Math.abs(d).toFixed(2)+'×',Math.sign(d)]},
  pct:(a,b)=>{const d=(b-a)*100;return !isFinite(d)||Math.abs(d)<0.05?null:[sgn(d)+Math.abs(d).toFixed(1)+' pts',0]},
  count:(a,b)=>{const d=b-a;return d?[sgn(d)+Math.abs(d),Math.sign(d)]:null},
  text:(a,b)=>a===b?null:['was '+a,0]};
export function metrics(){const C=state.E.compute();const k=C.kpi;const T=C.tot.HH;const O=state.E.onboarding(C);
  const fx=x=>isFinite(x)?x.toFixed(2)+'×':'n/a';
  const fin=[
    {id:'nw',k:'Economic net worth',v:T.A-T.L,f:gbpK,d:DELTA.money,up:'good'},
    {id:'fr',k:'Funded ratio',v:T.L?T.A/T.L:Infinity,f:fx,d:DELTA.ratio,up:'good'},
    {id:'cf',k:'Core funded ratio',v:k.coreFunded,f:fx,d:DELTA.ratio,up:'good'},
    {id:'iht',k:'IHT on second death',v:k.iht,f:gbpK,d:DELTA.money,up:'bad'},
    {id:'eq',k:'Equity exposure',v:k.totalEqPct,f:x=>pct(x),d:DELTA.pct,up:null}];
  const kyc=[
    {id:'st',k:'Onboarding status',v:O.stage,f:String,d:DELTA.text,up:null},
    {id:'aml',k:'AML rating',v:`${O.rating} (score ${O.score})`,f:String,d:DELTA.text,up:null},
    {id:'bl',k:'Blockers',v:O.blockerCount,f:String,d:DELTA.count,up:'bad'},
    {id:'rv',k:'Items to review',v:O.warnCount,f:String,d:DELTA.count,up:'bad'}];
  if(state.VIEW==='compliance')return kyc;
  if(state.VIEW==='members')return [fin[0],fin[1],kyc[1],kyc[2],kyc[3]];
  return [...fin,kyc[2]];
}
export let IMPACT={view:null,base:{},why:''};
export function imCell(m){const base=IMPACT.base[m.id];const d=base===undefined?null:m.d(base,m.v);let cls='';
  if(d&&d[1]&&m.up)cls=(d[1]>0)===(m.up==='good')?'up':'down';
  return `<div class="im" data-m="${m.id}"><div class="k">${esc(m.k)}</div><div class="v">${esc(m.f(m.v))}</div><div class="d ${cls}">${d?esc(d[0]):''}</div></div>`}
export function impactHTML(){const ms=metrics();
  if(IMPACT.view!==state.VIEW)IMPACT={view:state.VIEW,base:Object.fromEntries(ms.map(m=>[m.id,m.v])),why:''};
  return `<div class="impact" id="impact"><div class="impact-h"><b>Live effect of this section</b><span>Changes are compared with when you opened this section</span></div><div class="impact-grid">${ms.map(imCell).join('')}</div><div class="impact-why" id="impactWhy">${IMPACT.why||'Edit a field below and these figures update as you type.'}</div></div>`}
export function refreshImpact(label,f){const el=$('#impact');if(!el)return;const moved=[];
  for(const m of metrics()){const cell=el.querySelector(`.im[data-m="${m.id}"]`);if(!cell)continue;const tmp=document.createElement('div');tmp.innerHTML=imCell(m);const nc=tmp.firstChild;
    if(nc.querySelector('.v').textContent!==cell.querySelector('.v').textContent){moved.push(`${m.k} ${nc.querySelector('.v').textContent}`);nc.classList.add('flash');setTimeout(()=>nc.classList.remove('flash'),800)}
    cell.replaceWith(nc)}
  IMPACT.why=moved.length?`<b>${esc(label)}</b> changed: ${esc(moved.join(' · '))}.`:`<b>${esc(label)}</b> recorded. No change to the figures above${f&&f.h?': '+esc(f.h):'.'}`;
  const w=$('#impactWhy');if(w)w.innerHTML=IMPACT.why}
