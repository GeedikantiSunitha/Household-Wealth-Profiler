/* Tasks board: open actions across every household, filtered by owner and status. */
import { Store } from '../api/store.js';
import { $, esc } from '../lib/dom.js';
import { fmtDate } from '../lib/format.js';
import { state } from '../state.js';

const H = window.HWP;

export const TASKF={who:'',status:'open'};
export async function renderTasks(){
  let h=`<div class="sec-head"><div><h2>Tasks</h2><p>Every task across the firm\u2019s households. Assign and update tasks inside each household under Relationship › Tasks.</p></div></div>`;
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let rows=[];
  try{if(Store.mode==='server'){const list=await Store.list();for(const x of list)for(const t of (x.tasks||[]))rows.push({...t,hh:x.name||'Unnamed',id:x.id})}
    else for(const t of H.openTasks(state.S))rows.push({...t,hh:state.S.household.name||'This household',id:''})}
  catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='tasks')return;
  const t=H.today();const people=[...new Set(rows.map(r=>r.owner||'Unassigned'))].sort();
  const shown=rows.filter(r=>!TASKF.who||(r.owner||'Unassigned')===TASKF.who).sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')||({High:0,Normal:1,Low:2}[a.priority]-{High:0,Normal:1,Low:2}[b.priority]));
  const byWho=people.map(p=>({p,n:rows.filter(r=>(r.owner||'Unassigned')===p).length,od:rows.filter(r=>(r.owner||'Unassigned')===p&&r.due&&r.due<t).length}));
  h+=`<div class="kpis">${byWho.map(x=>`<button type="button" class="kpi kpi-btn${TASKF.who===x.p?' sel':''}" data-act="taskFilter" data-k="who" data-v="${TASKF.who===x.p?'':esc(x.p)}"><div class="k">${esc(x.p)}</div><div class="v">${x.n}</div><div class="s">${x.od?`<span class="pill bad">${x.od} overdue</span>`:'open tasks'}</div></button>`).join('')||'<div class="kpi"><div class="k">Open tasks</div><div class="v">0</div></div>'}</div>`;
  h+=`<div class="panel">${shown.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Due</th><th>Task</th><th>Household</th><th>Assigned to</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${shown.map(r=>{const od=r.due&&r.due<t;return `<tr><td style="white-space:nowrap">${r.due?fmtDate(r.due):'–'}${od?' <span class="pill bad">overdue</span>':''}</td><td><b>${esc(r.description||'Task')}</b></td><td>${esc(r.hh)}</td><td>${esc(r.owner||'Unassigned')}</td><td>${r.priority==='High'?'<span class="pill bad">High</span>':esc(r.priority)}</td><td>${esc(r.status)}</td><td>${r.id?`<button class="btn" type="button" data-act="openHousehold" data-id="${esc(r.id)}" data-view="actions">Open</button>`:`<button class="btn" type="button" data-nav="actions">Open</button>`}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty">No open tasks'+(TASKF.who?' for '+esc(TASKF.who):'')+'.</div>'}</div>`;
  $('#main').innerHTML=h;
}
