/* KYC and onboarding status: stages, due diligence per person, AML risk factors, disclosures and open items. */
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { fmtDate } from '../lib/format.js';
import { state } from '../state.js';

const H = window.HWP; const { SCHEMA, optList } = H;

export const STAGE_TEXT={done:'Complete',open:'Needs work',current:'Ready',waiting:'Not started'};
export function renderKyc(){
  const O=state.E.onboarding();const c=state.S.compliance;
  const ratingCls={Low:'good',Medium:'warn',High:'bad',Prohibited:'bad'}[O.rating];
  const stageCls=/Approved$|Approved with conditions/.test(O.stage)?'good':/Declined|Prohibited|open issues/.test(O.stage)?'bad':O.stage==='Ready for review'?'good':'warn';
  let h=`<div class="sec-head"><div><h2>KYC and onboarding status</h2><p>Customer due diligence, AML risk rating, suitability, disclosures and the four-eyes sign-off, worked out from what is recorded. Screening results are entered by hand; connect a screening provider for live checks.</p></div><div class="addrow"><button class="btn" type="button" data-nav="compliance">Edit onboarding details</button></div></div>`+bannerHTML();
  h+=`<div class="stages" role="list">${O.progress.map(p=>`<div class="stage" role="listitem" data-s="${p.status}"><b>${esc(p.label)}</b><span>${p.count?p.count+' to fix':STAGE_TEXT[p.status]}</span></div>`).join('')}</div>`;
  h+=`<div class="kpis">
    <div class="kpi"><div class="k">Status</div><div class="v t">${esc(O.stage)}</div><div class="s"><span class="pill ${stageCls}">${O.blockerCount} blockers · ${O.warnCount} to review</span></div></div>
    <div class="kpi"><div class="k">AML risk rating</div><div class="v t">${esc(O.rating)}</div><div class="s"><span class="pill ${ratingCls}">score ${O.score}${O.edd?' · EDD required':''}</span></div></div>
    <div class="kpi"><div class="k">Ongoing review</div><div class="v t">Every ${O.reviewYears} year${O.reviewYears>1?'s':''}</div><div class="s">${O.nextReview?'Next review '+fmtDate(O.nextReview):'Set when the file is approved'}</div></div>
    <div class="kpi"><div class="k">Sign-off</div><div class="v t">${esc(optList(H.fieldsOf(SCHEMA.compliance).find(f=>f.k==='outcome').o).find(o=>o[0]===c.outcome)?.[1]||'Pending review')}</div><div class="s">${c.preparer?'Prepared by '+esc(c.preparer):'Preparer not recorded'}${c.reviewer?' · reviewed by '+esc(c.reviewer):''}</div></div></div>`;
  // Per-person CDD
  const lvlPill=l=>`<span class="pill ${l==='ok'?'good':l==='warn'?'warn':'bad'}">${l==='ok'?'Done':l==='warn'?'Review':'Missing'}</span>`;
  h+=`<div class="kyc-grid">${O.people.map(p=>`<div class="panel"><h3>${esc(p.name)} <span class="muted" style="font:500 12px var(--f-mono)">${esc(p.ref)}</span></h3><div class="tbl-wrap"><table><tbody>${p.checks.map(x=>`<tr><td>${esc(x.label)}</td><td>${esc(x.detail)}</td><td class="n">${lvlPill(x.lvl)}</td></tr>`).join('')}</tbody></table></div></div>`).join('')||'<div class="empty">Add adults under People to start KYC.</div>'}</div>`;
  // AML factors and docs
  h+=`<div class="two"><div class="panel"><h3>AML risk factors</h3>${O.factors.length?`<div class="tbl-wrap"><table><tbody>${O.factors.map(f=>`<tr><td>${esc(f.why)}${f.edd?' <span class="pill bad">EDD</span>':''}</td><td class="n">+${f.pts}</td></tr>`).join('')}<tr class="t"><td>Total</td><td class="n">${O.score}</td></tr></tbody></table></div>`:'<p class="muted">No higher-risk factors recorded.</p>'}
    <p class="note">0–1 points: low (review every 3 years). 2–3: medium (2 years). 4 or more, any PEP, or a high-risk third country: high, with enhanced due diligence and yearly review.</p></div>
    <div class="panel"><h3>Disclosures</h3><ul class="list">${O.docs.map(d=>`<li><span class="pill ${d.ok?'good':d.optional?'neu':'bad'}">${d.ok?'Done':d.optional?'Later':'Missing'}</span><span class="grow">${esc(d.label)}</span><span class="muted">${d.date?fmtDate(d.date):''}</span></li>`).join('')}</ul></div></div>`;
  // Open items grouped by stage
  const groups=[['discovery','Discovery'],['kyc','KYC and AML'],['suitability','Suitability'],['documents','Disclosures'],['signoff','Compliance review']];
  const any=O.items.length;
  h+=`<div class="panel"><h3>Open items</h3>${any?groups.map(([k,l])=>{const its=O.items.filter(i=>i.stage===k);if(!its.length)return '';return `<h4 style="margin:12px 0 4px;font:600 11px/1 var(--f-body);letter-spacing:.09em;text-transform:uppercase;color:var(--muted)">${l}</h4><ul class="list">${its.map(i=>`<li><span class="pill ${i.lvl==='bad'?'bad':'warn'}">${i.lvl==='bad'?'Blocker':'Review'}</span><span class="grow">${esc(i.msg)}</span><button class="btn" type="button" data-nav="${esc(i.where)}">Open</button></li>`).join('')}</ul>`}).join(''):'<p><span class="pill good">Clear</span> Nothing outstanding.</p>'}
    <p class="note">These rules are a starting framework based on the Money Laundering Regulations 2017, JMLSG guidance, FCA COBS and the Consumer Duty. Align thresholds with your firm's own risk assessment before use.</p></div>`;
  return h;
}
