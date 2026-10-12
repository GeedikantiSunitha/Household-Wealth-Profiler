/* Risk profile and IPS: ability and willingness to take risk. */
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { gbp, gbpK, pct } from '../lib/format.js';
import { isAdult, memberName } from '../lib/people.js';
import { state } from '../state.js';

const H = window.HWP; const { N, has, yes } = H;

export function renderRisk(){
  const C=state.E.compute();const R=state.E.riskProfile(C);const k=C.kpi;const a=state.S.assumptions;
  const cls=x=>x==='Above average'?'good':x==='Below average'?'bad':'warn';
  let h=`<div class="sec-head"><div><h2>Risk profile and IPS</h2><p>Ability to take risk comes from the balance sheet. Willingness comes from the client. The CFA approach adopts the lower of the two and treats any gap as a conversation.</p></div></div>`+bannerHTML();
  h+=`<div class="kpis">
   <div class="kpi"><div class="k">Ability to take risk</div><div class="v t">${R.ability}</div><div class="s"><span class="pill ${cls(R.ability)}">score ${R.abilityScore>0?'+':''}${R.abilityScore}</span></div></div>
   <div class="kpi"><div class="k">Willingness to take risk</div><div class="v t">${R.willingness}</div><div class="s">Average ${R.willAvg.toFixed(1)} of 7 after loss reaction</div></div>
   <div class="kpi"><div class="k">Overall risk tolerance</div><div class="v t">${R.overall}</div><div class="s"><span class="pill ${cls(R.overall)}">use for asset allocation</span></div></div>
   <div class="kpi"><div class="k">Equity exposure incl. human capital</div><div class="v">${pct(k.totalEqPct)}</div><div class="s">Portfolio ${pct(k.finEqPct)} · earnings ${pct(k.hcEqPct)} equity-like</div></div></div>`;
  h+=`<div class="panel"><h3>Ability factors</h3><div class="tbl-wrap"><table><thead><tr><th>Factor</th><th>Evidence</th><th class="n">Points</th></tr></thead><tbody>${R.f.map(x=>`<tr><td>${esc(x.label)}</td><td>${esc(x.why)}</td><td class="n">${x.pts>0?'+':''}${x.pts}</td></tr>`).join('')}</tbody></table></div>`;
  if(R.ability!==R.willingness){const low={'Below average':0,'Average':1,'Above average':2};const willLower=low[R.willingness]<low[R.ability];
    h+=`<p class="note"><b>${willLower?'Willingness is below ability.':'Willingness exceeds ability.'}</b> ${willLower?'Explain the cost of holding less risk than the plan can bear before deciding.':'Recommend the lower level and record why.'} Record the rationale under Onboarding and compliance.</p>`}
  if(R.will.length>1&&Math.max(...R.will)-Math.min(...R.will)>=2)h+=`<p class="note"><b>Partners differ.</b> Risk scores range from ${Math.min(...R.will)} to ${Math.max(...R.will)}. Consider separate portfolios for each person's own wrappers.</p>`;
  h+=`</div>`;
  const ad=C.adl.filter(isAdult);const ret=ad.map(m=>({n:memberName(m.ref),y:Math.max(0,(N(m.retireAge)||65)-(C.derived[m.ref].age||0))})).sort((x,y)=>x.y-y.y);
  const near=state.S.goals.filter(g=>N(g.inYears)<=3).reduce((s,g)=>s+N(g.amount),0)+state.S.expenses.filter(e=>e.cat==='education'&&N(e.startIn)<=0).reduce((s,e)=>s+N(e.amount)*Math.min(3,has(e.duration)?N(e.duration):3),0);
  const fin=k.finAssets||1;const emp=state.S.accounts.filter(x=>x.wrapper==='Employer shares / options').reduce((s,x)=>s+N(x.value),0);
  const prot=ad.map(m=>{const hc=C.derived[m.ref].hc;const cover=state.S.protection.filter(p=>p.owner===m.ref&&/Life|Death|Family/.test(p.type)).reduce((s,p)=>s+N(p.sum),0);return {n:memberName(m.ref),hc,cover,gap:hc-cover}});
  const flags=[];if(!yes(state.S.household.willsInPlace))flags.push('no wills');if(!yes(state.S.household.lpaInPlace))flags.push('no lasting powers of attorney');ad.forEach(m=>{if(yes(m.usPerson))flags.push(memberName(m.ref)+' is a US person');if(m.residence!=='uk')flags.push(memberName(m.ref)+' is not UK resident')});
  const vul=ad.filter(m=>m.vulnerability&&m.vulnerability!=='None identified').map(m=>`${memberName(m.ref)} (${m.vulnerability})`);
  h+=`<div class="ips">
    <div class="panel"><h3>Return objective</h3><p>Grow assets to fund ${gbpK(C.tot.HH.cons)} of lifetime spending and ${gbpK(C.tot.HH.goal)} of goals and legacy, in present-value terms.</p><p class="muted">The funded ratio of ${isFinite(k.funded)?k.funded.toFixed(2):'n/a'}× means the plan ${k.funded>=1.2?'does not need to take extra risk to succeed; the surplus is discretionary':k.funded>=1?'is on track but has little margin for poor returns':'needs a higher return, more saving, later retirement or lower spending'}.</p></div>
    <div class="panel"><h3>Time horizon</h3><p>Multi-stage. Accumulation for about ${Math.round(ret[0]?.y||0)} years until ${esc(ret[0]?.n||'first retirement')} retires, then decumulation to year ${C.H}.</p><p class="muted">Life expectancy: ${ad.map(m=>`${esc(memberName(m.ref))} about ${Math.round((C.derived[m.ref].age||0)+(C.derived[m.ref].le||0))}`).join(', ')}. The plan runs to ${esc(a.planAge)}.</p></div>
    <div class="panel"><h3>Liquidity</h3><p>Hold ${gbpK(k.essential/2)} to ${gbpK(k.essential)} as an emergency reserve (6 to 12 months of essential spending). Cash today is ${gbpK(k.cashLiquid)}.</p><p class="muted">Known needs within 3 years: ${gbpK(near)}. Uncalled commitments: ${gbpK(k.uncalled)}.</p></div>
    <div class="panel"><h3>Taxes</h3><p>${ad.map(m=>`${esc(memberName(m.ref))}: ${C.tax[m.ref].band.toLowerCase()} rate, ${pct(C.tax[m.ref].marginal)} marginal`).join('. ')}.</p><p class="muted">Fill ISAs before GIAs, use pension relief at the highest marginal rate, and hold income-producing assets in wrappers. IHT estimate on second death: ${gbpK(k.iht)}.</p></div>
    <div class="panel"><h3>Legal and regulatory</h3><p>${flags.length?'Gaps: '+esc(flags.join('; '))+'.':'Wills and powers of attorney recorded; no residence or US issues.'}</p><p class="muted">Long-term residence status: ${ad.map(m=>`${esc(memberName(m.ref))} ${N(m.ukYears)>=10?'yes':'no'}`).join(', ')}.</p></div>
    <div class="panel"><h3>Unique circumstances</h3><p>${emp/fin>0.1?`Employer shares are ${pct(emp/fin)} of financial assets, above a 10% concentration limit. `:''}${vul.length?`Vulnerability noted for ${esc(vul.join(', '))}. `:''}${ad.some(m=>m.esg&&m.esg!=='None')?'Sustainability preferences recorded. ':''}${(emp/fin<=0.1&&!vul.length)?'No concentration or vulnerability issues recorded.':''}</p></div></div>`;
  h+=`<div class="panel"><h3>Mortality risk: human capital vs life cover</h3><div class="tbl-wrap"><table><thead><tr><th>Earner</th><th class="n">Human capital</th><th class="n">Life cover</th><th class="n">Gap</th></tr></thead><tbody>${prot.map(p=>`<tr><td>${esc(p.n)}</td><td class="n">${gbp(p.hc)}</td><td class="n">${gbp(p.cover)}</td><td class="n">${p.gap>0?`<span class="pill ${p.gap>p.hc*0.5?'bad':'warn'}">${gbp(p.gap)}</span>`:'<span class="pill good">covered</span>'}</td></tr>`).join('')}</tbody></table></div>
    <p class="note">Human-life-value view: the upper bound of cover needed to replace lost earnings. A needs-based review would subtract the earner's own consumption and add debts and goals.</p></div>`;
  return h;
}
