/* Reviews due for the open household: annual review, KYC refresh, expiries, actions and complaint deadlines. */
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { fmtDate } from '../lib/format.js';
import { state } from '../state.js';

export const REVIEW_CLS={overdue:'bad',soon:'warn',later:'neu'};
export function renderReviews(){
  const R=state.E.reviews();
  let h=`<div class="sec-head"><div><h2>Reviews due</h2><p>Every dated obligation for this household: the annual suitability review, the KYC refresh, document expiries, open actions, life events and complaint deadlines. Worked out from the file; nothing is entered here.</p></div></div>`+bannerHTML(false);
  h+=`<div class="kpis"><div class="kpi"><div class="k">Overdue</div><div class="v">${R.overdue}</div></div><div class="kpi"><div class="k">Due in 60 days</div><div class="v">${R.soon}</div></div><div class="kpi"><div class="k">Next due</div><div class="v t">${R.nextDue?fmtDate(R.nextDue):'Nothing scheduled'}</div></div></div>`;
  if(!R.items.length)return h+`<div class="empty">Nothing is due. Items appear once the file is approved, documents have dates, or actions, life events and complaints are recorded.</div>`;
  h+=`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Due</th><th>Status</th><th>Item</th><th>Who</th><th>Detail</th><th></th></tr></thead><tbody>${R.items.map(i=>`<tr><td style="white-space:nowrap">${fmtDate(i.due)}</td><td><span class="pill ${REVIEW_CLS[i.status]}">${i.status==='overdue'?Math.abs(i.days)+' days overdue':i.status==='soon'?'in '+i.days+' days':'scheduled'}</span></td><td><b>${esc(i.type)}</b></td><td>${esc(i.who)}</td><td class="muted">${esc(i.detail)}</td><td><button class="btn" type="button" data-nav="${esc(i.where)}">Open</button></td></tr>`).join('')}</tbody></table></div></div>`;
  return h;
}
