/* Client list: every household with its stage, AML rating and next review. */
import { Store } from '../api/store.js';
import { $, esc } from '../lib/dom.js';
import { fmtDate, fmtTs } from '../lib/format.js';
import { state } from '../state.js';

export async function renderClients(){
  let h=`<div class="sec-head"><div><h2>Households</h2><p>Signed in as ${esc(Store.user)}. ${Store.encrypted?'Client files are encrypted at rest.':'<b>Encryption at rest is off.</b> Set DATA_KEY on the server.'}</p></div><div class="addrow"><button class="btn" type="button" data-act="newSample">New from sample</button><button class="btn primary" type="button" data-act="newBlank">New household</button></div></div>`;
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.list()}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>Could not load households. ${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='clients')return;
  const rc={Low:'good',Medium:'warn',High:'bad',Prohibited:'bad'};
  h+=`<div class="panel">${list.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Household</th><th>Status</th><th>AML</th><th>Next due</th><th>Last change</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${esc(x.name||'Unnamed')}</b><br><span class="muted">${esc(x.reference||'')}</span></td><td>${esc(x.stage)}${x.blockers?` <span class="pill bad">${x.blockers}</span>`:''}</td><td><span class="pill ${rc[x.rating]||'neu'}">${esc(x.rating)}</span></td><td>${x.due?fmtDate(x.due):'–'}${x.overdue?` <span class="pill bad">${x.overdue} overdue</span>`:''}</td><td>${esc(fmtTs(x.updatedAt))}<br><span class="muted">${esc(x.updatedBy||'')}</span></td><td><button class="btn" type="button" data-act="openHousehold" data-id="${esc(x.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No households yet. Create one to start onboarding.</div>'}</div>`;
  $('#main').innerHTML=h;
}
