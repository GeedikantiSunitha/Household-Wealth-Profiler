/* Economic balance sheet (CFA framework): assets, liabilities, composition and memorandum items, for the household or one person. */
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { gbp, gbpK, pct } from '../lib/format.js';
import { memberName } from '../hooks/people.js';
import { state } from '../hooks/state.js';

const H = window.HWP; const { yes } = H;

import { GROUPS_A, GROUPS_L } from '../content/balance-sheet.js';
export { GROUPS_A, GROUPS_L };
export const COLORS={fin:'var(--asset)',real:'var(--asset2)',hc:'var(--hc)',pen:'var(--pen)',debt:'var(--liab)',cons:'var(--liab2)',goal:'var(--liab3)',tax:'var(--muted)'};
export function renderBS(){
  const C=state.E.compute();const v=state.BSVIEW in C.tot?state.BSVIEW:'HH';const T=C.tot[v];const k=C.kpi;
  const fr=x=>isFinite(x)?x.toFixed(2)+'×':'n/a';const pill=(x,g,w)=>x>=g?'good':x>=w?'warn':'bad';
  const fv=T.L?T.A/T.L:Infinity;
  let h=`<div class="sec-head"><div><h2>Economic balance sheet</h2><p>Present values of everything the household owns, will earn and has committed to spend, following the CFA Institute private wealth framework. Values are in pounds today.</p></div></div>`+bannerHTML();
  h+=`<div class="kpis">
   <div class="kpi"><div class="k">Economic net worth</div><div class="v">${gbpK(T.A-T.L)}</div><div class="s">Assets ${gbpK(T.A)} less liabilities ${gbpK(T.L)}</div></div>
   <div class="kpi"><div class="k">Funded ratio</div><div class="v">${fr(fv)}</div><div class="s"><span class="pill ${pill(fv,1.2,1)}">${fv>=1.2?'Surplus':fv>=1?'Tight':'Shortfall'}</span></div></div>
   <div class="kpi"><div class="k">Core funded ratio</div><div class="v">${fr(k.coreFunded)}</div><div class="s">Household: against debt, essential spending and tax</div></div>
   <div class="kpi"><div class="k">Human capital share</div><div class="v">${pct(T.A?T.hc/T.A:0)}</div><div class="s">of economic assets</div></div>
   <div class="kpi"><div class="k">Cash runway</div><div class="v">${isFinite(k.cashMonths)?k.cashMonths.toFixed(0)+' mo':'n/a'}</div><div class="s"><span class="pill ${pill(k.cashMonths,12,6)}">${k.cashMonths>=12?'Comfortable':k.cashMonths>=6?'Adequate':'Thin'}</span> essential + debt payments</div></div>
   <div class="kpi"><div class="k">Traditional net worth</div><div class="v">${gbpK(k.tradNW)}</div><div class="s">Market assets less debt</div></div></div>`;
  h+=`<div class="viewbar"><span class="muted" style="font-size:12.5px;margin-right:4px">View</span><div class="seg" role="group" aria-label="Balance sheet view">${C.views.map(x=>`<button type="button" data-act="bsview" data-v="${esc(x)}" aria-pressed="${x===v}">${x==='HH'?'Household':esc(memberName(x))}</button>`).join('')}</div></div>`;
  const max=Math.max(T.A,T.L)||1;const bar=groups=>groups.map(([g,l])=>T[g]>0?`<i style="width:${(T[g]/max*100).toFixed(2)}%;background:${COLORS[g]}" title="${esc(l)}: ${gbp(T[g])}"></i>`:'').join('');
  h+=`<div class="comp"><h3>Composition</h3>
    <div class="barrow"><span class="lbl">Assets</span><div class="bar">${bar(GROUPS_A)}</div><span class="tot">${gbpK(T.A)}</span></div>
    <div class="barrow"><span class="lbl">Liabilities</span><div class="bar">${bar(GROUPS_L)}</div><span class="tot">${gbpK(T.L)}</span></div>
    <div class="legend">${[...GROUPS_A,...GROUPS_L].map(([g,l])=>`<span><i style="background:${COLORS[g]}"></i>${esc(l)}</span>`).join('')}</div></div>`;
  const side=(sd,groups,cls,title)=>{let rows='';for(const [g,l] of groups){const ls=C.lines.filter(x=>x.side===sd&&x.group===g);const agg={};for(const x of ls){const val=C.val(x,v);if(Math.abs(val)<0.5)continue;agg[x.label]=agg[x.label]||{v:0,note:x.note};agg[x.label].v+=val}
      const ent=Object.entries(agg);rows+=`<tr class="g"><td>${esc(l)}</td><td class="n">${gbp(T[g])}</td></tr>`;
      if(!ent.length)rows+=`<tr class="sub"><td class="muted">None recorded</td><td class="n muted">–</td></tr>`;
      for(const [lab,o] of ent)rows+=`<tr class="sub"><td>${esc(lab)}${o.note?` <span class="muted">· ${esc(o.note)}</span>`:''}</td><td class="n">${gbp(o.v)}</td></tr>`}
    rows+=`<tr class="t"><td>Total ${sd==='A'?'economic assets':'economic liabilities'}</td><td class="n">${gbp(T[sd])}</td></tr>`;
    return `<div class="panel ${cls}"><h3>${title}</h3><div class="tbl-wrap"><table><tbody>${rows}</tbody></table></div></div>`};
  h+=`<div class="bs">${side('A',GROUPS_A,'side-a','Assets')}${side('L',GROUPS_L,'side-l','Liabilities')}</div>`;
  h+=`<div class="panel"><h3>Memorandum items</h3><div class="tbl-wrap"><table><tbody>
    <tr><td>Estimated IHT on second death (today)</td><td class="n">${gbp(k.iht)}</td></tr>
    <tr><td class="muted">Estate ${gbp(k.estate)} · nil-rate bands ${gbp(k.nrb)} · residence band ${gbp(k.rnrb)}${yes(state.S.assumptions.pensionIHT)?' · pensions included':''}${k.coverInEstate?` · ${gbp(k.coverInEstate)} life cover not in trust`:''}</td><td></td></tr>
    <tr><td>Uncalled private-market commitments</td><td class="n">${gbp(k.uncalled)}</td></tr>
    <tr><td>Life and death-in-service cover in force</td><td class="n">${gbp(k.lifeCover)}</td></tr>
    <tr><td>Planning horizon (to last survivor at age ${esc(state.S.assumptions.planAge)})</td><td class="n">${k.H} yrs</td></tr></tbody></table></div>
    <p class="note">Method: human capital is the survival-weighted present value of after-tax earnings to retirement, discounted at the gilt rate plus an income-stability premium. Pension rights, including a spouse's pension from defined benefit schemes, and benefits such as ESA are discounted at the gilt rate. Spending and goals grow with inflation and are discounted at the gilt rate. Rental income is excluded because the property value already captures it. Joint items are split equally between the adults.</p></div>`;
  return h;
}
