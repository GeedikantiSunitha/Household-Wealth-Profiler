/* Mandate check: the agreed mandate against the model portfolio, the current holdings and the risk profile. */
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { fmtDate, gbp } from '../lib/format.js';
import { state } from '../state.js';

const H = window.HWP; const { N, has } = H;

export function renderDrift(){
  const M=state.E.mandateCheck();const S_=state.S.mandate;const scls={'In line':'good',Drift:'warn',Incomplete:'bad'}[M.status];
  let h=`<div class="sec-head"><div><h2>Mandate check</h2><p>The agreed mandate against the risk profile and the current accounts. Targets come from the model portfolio; the current split is value-weighted across every account under Savings and investments.</p></div><div class="addrow"><button class="btn" type="button" data-nav="mandate">Edit mandate</button></div></div>`+bannerHTML(false);
  h+=`<div class="kpis">
    <div class="kpi"><div class="k">Model portfolio</div><div class="v t">${esc(M.model?M.model.name:'None chosen')}</div><div class="s">${esc(M.benchmark||'')}</div></div>
    <div class="kpi"><div class="k">Agreed risk level</div><div class="v">${M.risk||'–'}</div><div class="s">Profile: ${esc(M.profile)} (${M.suggested[0]}–${M.suggested[1]})${M.model?` · model ${M.model.riskMin}–${M.model.riskMax}`:''}</div></div>
    <div class="kpi"><div class="k">Status</div><div class="v t">${M.status}</div><div class="s"><span class="pill ${scls}">${M.breaches?M.breaches+' class'+(M.breaches>1?'es':'')+' outside ±'+M.tol+' pts':M.model?'within ±'+M.tol+' pts':'set up the mandate'}</span></div></div>
    <div class="kpi"><div class="k">Next mandate review</div><div class="v t">${M.nextReview?fmtDate(M.nextReview):'–'}</div><div class="s">${S_.basis||''}${S_.rebalance?' · rebalance '+S_.rebalance.toLowerCase():''}</div></div></div>`;
  if(M.issues.length)h+=`<div class="panel"><h3>To resolve</h3><ul class="list">${M.issues.map(i=>`<li><span class="pill ${i.lvl==='bad'?'bad':'warn'}">${i.lvl==='bad'?'Blocker':'Review'}</span><span class="grow">${esc(i.msg)}</span>${i.where&&i.where!=='drift'?`<button class="btn" type="button" data-nav="${esc(i.where)}">Open</button>`:''}</li>`).join('')}</ul></div>`;
  h+=`<div class="two"><div class="panel"><h3>Allocation against target</h3>${M.invested?`<div class="tbl-wrap"><table><thead><tr><th>Asset class</th><th class="n">Target</th><th class="n">Current</th><th class="n">Difference</th><th></th></tr></thead><tbody>${M.classes.map(c=>`<tr><td>${esc(c.l)}</td><td class="n">${c.target.toFixed(0)}%</td><td class="n">${c.current.toFixed(0)}%</td><td class="n">${c.diff>0?'+':''}${c.diff.toFixed(1)}</td><td>${M.model?`<span class="pill ${c.breach?'warn':'good'}">${c.breach?'drift':'ok'}</span>`:''}</td></tr>`).join('')}</tbody></table></div><p class="note">Invested value ${gbp(M.invested)}. Equities include the equity share of alternatives only where accounts record it as equity. Holding-level drift across the eight classes arrives with portfolio tracking.</p>`:'<p class="muted">No account values recorded.</p>'}</div>
    <div class="panel"><h3>${esc(M.model?M.model.name+' target':'Model target')}</h3>${M.model?`<div class="tbl-wrap"><table><thead><tr><th>Asset class</th><th class="n">Target</th></tr></thead><tbody>${M.target8.map(t=>`<tr><td>${esc(t.l)}</td><td class="n">${t.pct}%</td></tr>`).join('')}<tr class="t"><td>Total</td><td class="n">${M.target8.reduce((a,t)=>a+t.pct,0)}%</td></tr></tbody></table></div>${M.model.description?`<p class="note">${esc(M.model.description)}</p>`:''}`:'<p class="muted">Choose a model portfolio under Mandate.</p>'}</div></div>`;
  h+=`<div class="panel"><h3>Objectives and constraints</h3><p><b>Objective:</b> ${esc(S_.objective||'–')}${has(S_.incomeNeed)?` · <b>Income required:</b> ${gbp(N(S_.incomeNeed))} a year`:''}${has(S_.horizon)?` · <b>Horizon:</b> ${S_.horizon} years`:''}</p><p><b>Restrictions:</b> ${esc(S_.restrictions||'None recorded')}</p><p class="muted">${S_.agreedOn?`Agreed ${fmtDate(S_.agreedOn)}${S_.agreedBy?' by '+esc(S_.agreedBy):''}.`:'Not yet agreed with the client.'}${S_.reviewedOn?` Last reviewed ${fmtDate(S_.reviewedOn)}.`:''}</p></div>`;
  return h;
}
