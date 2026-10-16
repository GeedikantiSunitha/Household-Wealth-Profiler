/* Tax and allowances: income tax, NI and unused allowances per person. */
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { gbp, pct } from '../lib/format.js';
import { isAdult, memberName } from '../hooks/people.js';
import { state } from '../hooks/state.js';

const H = window.HWP; const { N, yes } = H;

export function renderTax(){
  const C=state.E.compute();const a=state.S.assumptions;let h=`<div class="sec-head"><div><h2>Tax and allowances</h2><p>Indicative 2026/27 position for each person, using rest-of-UK bands. Use it to spot unused allowances and cliff edges, not to file a return.</p></div></div>`+bannerHTML();
  const ad=state.S.members.filter(isAdult);const kids=state.S.members.filter(m=>m.role==='child');
  if(!ad.length)return h+`<div class="empty">Add at least one adult under People.</div>`;
  const row=(l,f,cls='n')=>`<tr><td>${l}</td>${ad.map(m=>`<td class="${cls}">${f(C.tax[m.ref],m)}</td>`).join('')}</tr>`;
  const head=`<tr><th></th>${ad.map(m=>`<th class="n">${esc(memberName(m.ref))}</th>`).join('')}</tr>`;
  h+=`<div class="panel"><h3>Income tax and National Insurance</h3><div class="tbl-wrap"><table><thead>${head}</thead><tbody>
    ${row('Employment income',t=>gbp(t.emp))}${row('Self-employment profit',t=>gbp(t.self))}${row('Dividends (incl. GIA yield)',t=>gbp(t.div))}${row('Savings interest (estimated)',t=>gbp(t.sav))}${row('Other taxable income',t=>gbp(t.nonSavOther))}
    ${row('Adjusted net income',t=>gbp(t.ani))}${row('Personal allowance',t=>gbp(t.pa))}${row('Income tax',t=>gbp(t.tax))}${row('National Insurance',t=>gbp(t.ni))}
    ${row('Top band',t=>t.band,'')}${row('Marginal rate on next £',t=>`<span class="pill ${t.marginal>=0.55?'bad':t.marginal>=0.4?'warn':'neu'}">${pct(t.marginal,0)}</span>`)}
    </tbody></table></div></div>`;
  h+=`<div class="panel"><h3>Allowances used this tax year</h3><div class="tbl-wrap"><table><thead>${head}</thead><tbody>
    ${row('ISA subscriptions',t=>`${gbp(t.isaUsed)} of ${gbp(N(a.isa))}`)}${row('ISA headroom',t=>`<b>${gbp(Math.max(0,N(a.isa)-t.isaUsed))}</b>`)}
    ${row('Lifetime ISA',t=>`${gbp(t.lisaUsed)} of ${gbp(N(a.lisa))}`)}
    ${row('Pension contributions (incl. employer)',t=>gbp(t.penUsed))}${row('Annual allowance available',t=>`${gbp(t.aa)}${t.tapered?' <span class="pill warn">tapered</span>':''}`)}${row('Pension headroom (before carry forward)',t=>`<b>${gbp(t.aa-t.penUsed)}</b>`)}
    ${row('Unrealised gains in GIA, shares, crypto',t=>gbp(t.unreal))}${row('CGT annual exempt amount',()=>gbp(N(a.cgtAE)))}${row('Dividend allowance',()=>gbp(N(a.divAll)))}
    </tbody></table></div>
    ${kids.length?`<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Child</th><th class="n">Junior ISA paid in</th><th class="n">Headroom</th></tr></thead><tbody>${kids.map(m=>`<tr><td>${esc(memberName(m.ref))}</td><td class="n">${gbp(C.tax[m.ref].jisaUsed)}</td><td class="n">${gbp(Math.max(0,N(a.jisa)-C.tax[m.ref].jisaUsed))}</td></tr>`).join('')}</tbody></table></div>`:''}</div>`;
  const obs=[];
  for(const m of ad){const t=C.tax[m.ref];const n=esc(memberName(m.ref));
    if(t.ani>N(a.paTaper)&&t.ani<N(a.arl))obs.push(['warn',`${n} is in the personal allowance taper (adjusted net income ${gbp(t.ani)}). A further pension contribution of up to ${gbp(t.ani-N(a.paTaper))} gets an effective 60% relief.`]);
    if(t.ani>N(a.hicbc)&&kids.some(k=>(state.E.ageOf(k)??99)<16))obs.push(['warn',`${n}: adjusted net income above ${gbp(N(a.hicbc))}. The High Income Child Benefit Charge applies if child benefit is claimed.`]);
    if(t.tapered)obs.push(['warn',`${n}: pension annual allowance is tapered to ${gbp(t.aa)}.`]);
    if(t.penUsed>t.aa)obs.push(['bad',`${n}: contributions of ${gbp(t.penUsed)} exceed the available allowance. Check carry forward from the last three years.`]);
    if(t.ras+t.netpay>t.emp+t.self+t.div&&t.ras+t.netpay>3600)obs.push(['bad',`${n}: personal contributions exceed relevant UK earnings, so tax relief is restricted.`]);
    if(t.isaUsed<N(a.isa)&&m.residence!=='nonuk')obs.push(['neu',`${n}: ${gbp(N(a.isa)-t.isaUsed)} of ISA allowance unused this year.`]);
    if(t.unreal>N(a.cgtAE))obs.push(['neu',`${n}: consider realising up to ${gbp(N(a.cgtAE))} of gains this year, or moving GIA holdings into the ISA.`]);
    if(yes(m.flexAccessed))obs.push(['warn',`${n}: Money Purchase Annual Allowance applies.`]);
    obs.push(['neu',`${n}: ${N(m.ukYears)>=10?'long-term UK resident, so worldwide assets fall within IHT':'not a long-term UK resident, so only UK assets fall within IHT'}.`]);}
  h+=`<div class="panel"><h3>Observations</h3><ul class="list">${obs.map(([l,t])=>`<li><span class="pill ${l}">${l==='bad'?'Action':l==='warn'?'Review':'Note'}</span><span class="grow">${t}</span></li>`).join('')}</ul>
    <p class="note">Not modelled: Scottish bands, carry forward, salary-sacrifice adjustments to threshold income, and DB accrual against the annual allowance.</p></div>`;
  return h;
}
