/* Life-event scenarios: the balance sheet and tax effect of a chosen event set against the current position. */
import { bannerHTML } from '../components/banner.js';
import { fieldsBlock } from '../components/form.js';
import { esc } from '../lib/dom.js';
import { gbpK } from '../lib/format.js';
import { state } from '../hooks/state.js';

export function renderScenarios(){
  const R=state.E.scenarios();const B=R.before;const fx=x=>isFinite(x)?x.toFixed(2)+'×':'n/a';
  const dm=(a,b,good)=>{const d=b-a;if(Math.abs(d)<500)return '<span class="muted">no change</span>';const up=d>0;return `<span class="${up===good?'up':'down'}">${up?'+':'−'}${gbpK(Math.abs(d))}</span>`};
  const sel=R.list.find(x=>x.id===state.SCEN_SEL)||R.list[0];
  let h=`<div class="sec-head"><div><h2>Life-event scenarios</h2><p>Each scenario changes a copy of this household and re-runs the full model, so the effect on the balance sheet, IHT and liquidity is worked out the same way as the base case. Choose a scenario for what changes and how to mitigate it.</p></div></div>`+bannerHTML(false);
  h+=`<div class="kpis"><div class="kpi"><div class="k">Economic net worth today</div><div class="v">${gbpK(B.nw)}</div></div><div class="kpi"><div class="k">Funded ratio today</div><div class="v">${fx(B.funded)}</div></div><div class="kpi"><div class="k">IHT on second death today</div><div class="v">${gbpK(B.iht)}</div></div><div class="kpi"><div class="k">Cash runway today</div><div class="v">${isFinite(B.cash)?Math.round(B.cash)+' mo':'–'}</div></div></div>`;
  h+=`<div class="panel"><div class="tbl-wrap"><table class="scen"><thead><tr><th>Scenario</th><th class="n">Net worth</th><th class="n">Funded ratio</th><th class="n">Capital needed to stay funded</th><th class="n">IHT</th><th class="n">Cash runway</th></tr></thead><tbody>
    ${R.list.map(x=>{const A=x.after;return `<tr data-act="scenSel" data-id="${esc(x.id)}" class="${x===sel?'sel':''}" tabindex="0"><td><b>${esc(x.title)}</b></td><td class="n">${dm(B.nw,A.nw,true)}</td><td class="n">${fx(B.funded)} → <b class="${A.funded>=1?'':'neg'}">${fx(A.funded)}</b></td><td class="n">${A.gap>500?`<b class="neg">${gbpK(A.gap)}</b>`:'<span class="muted">none</span>'}</td><td class="n">${dm(B.iht,A.iht,false)}</td><td class="n">${isFinite(A.cash)?Math.round(A.cash)+' mo':'–'}</td></tr>`}).join('')}</tbody></table></div>
    <p class="note">Capital needed to stay funded is the lump sum that would bring the funded ratio back to 1.0×: for death and illness scenarios, the extra cover to consider. All values are in today’s money.</p></div>`;
  if(sel){const A=sel.after;
    const row=(l,a,b,f,good)=>`<tr><td>${l}</td><td class="n">${f(a)}</td><td class="n"><b>${f(b)}</b></td><td class="n">${good===null?'':dm(a,b,good)}</td></tr>`;
    h+=`<div class="two"><div class="panel"><h3>${esc(sel.title)}</h3><p>${esc(sel.desc)}</p>
      <div class="tbl-wrap"><table><thead><tr><th></th><th class="n">Today</th><th class="n">After</th><th class="n">Change</th></tr></thead><tbody>
      ${row('Economic net worth',B.nw,A.nw,gbpK,true)}${row('Funded ratio',B.funded,A.funded,fx,null)}${row('Core funded ratio',B.core,A.core,fx,null)}${row('Capital needed to stay funded',B.gap,A.gap,gbpK,false)}${row('IHT on second death',B.iht,A.iht,gbpK,false)}${row('Cash runway (months)',B.cash,A.cash,v=>isFinite(v)?Math.round(v)+'':'–',null)}</tbody></table></div>
      ${/^death/.test(sel.id)&&A.nw>B.nw?'<p class="note">Net worth rises here because the cover paid out and the lower spending assumed for the survivor are worth more than the earnings lost. Check the survivor spending assumption below; if spending would not fall, the result changes.</p>':''}
      ${sel.id==='rates'?'<p class="note">Rising rates can raise economic net worth: decades of future spending are longer-dated than most assets, so their present value falls further. The cost shows up in loan payments and the cash runway.</p>':''}</div>
      <div class="panel"><h3>What the scenario changes</h3><ul class="list">${sel.notes.map(n=>`<li><span class="grow">${esc(n)}</span></li>`).join('')}</ul>
      <h3 style="margin-top:16px">Ways to mitigate</h3><ul class="list">${sel.mitigations.map(n=>`<li><span class="pill neu">Consider</span><span class="grow">${esc(n)}</span></li>`).join('')}</ul></div></div>`}
  h+=`<details class="panel"${state.OPEN.has('scen:settings')?' open':''} id="scenSettings"><summary><b>Scenario assumptions</b> <span class="muted">who the scenarios apply to, spending after a death or separation, care costs, market fall and more</span></summary><div style="margin-top:12px">${fieldsBlock('scen',0,state.S.scen)}</div></details>`;
  return h}
