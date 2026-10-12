/* Reviews due across the firm: households with the soonest obligation first. */
import { Store } from '../api/store.js';
import { $, esc } from '../lib/dom.js';
import { fmtDate } from '../lib/format.js';
import { state } from '../state.js';

const H = window.HWP;

export async function renderDiary(){
  let h=`<div class="sec-head"><div><h2>Reviews due</h2><p>Households with the soonest obligation first. Open a household and go to Reviews due for the detail.</p></div></div>`;
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.list()}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='diary')return;
  const t=H.today();const rows=list.filter(x=>x.due).sort((a,b)=>a.due.localeCompare(b.due));
  const overdue=rows.reduce((n,x)=>n+(x.overdue||0),0);
  h+=`<div class="kpis"><div class="kpi"><div class="k">Households with something overdue</div><div class="v">${rows.filter(x=>x.overdue).length}</div></div><div class="kpi"><div class="k">Overdue items</div><div class="v">${overdue}</div></div><div class="kpi"><div class="k">Due in the next 60 days</div><div class="v">${rows.filter(x=>x.due>=t&&x.due<=H.addDays(t,60)).length}</div></div></div>`;
  h+=`<div class="panel">${rows.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Household</th><th>Next due</th><th>Overdue</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.name||'Unnamed')}</b><br><span class="muted">${esc(x.reference||'')}</span></td><td>${fmtDate(x.due)}</td><td>${x.overdue?`<span class="pill bad">${x.overdue} overdue</span>`:`<span class="pill ${x.due<=H.addDays(t,60)?'warn':'neu'}">${x.due<=H.addDays(t,60)?'due soon':'scheduled'}</span>`}</td><td>${esc(x.stage)}</td><td><button class="btn" type="button" data-act="openHousehold" data-id="${esc(x.id)}" data-view="reviews">Open</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Nothing is due across the firm.</div>'}</div>`;
  $('#main').innerHTML=h;
}
