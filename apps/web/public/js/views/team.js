/* Team and access (Supabase edition): members, invitations and seats. */
import { Store } from '../api/store.js';
import { bannerHTML } from '../components/banner.js';
import { $, esc } from '../lib/dom.js';
import { state } from '../state.js';

export async function renderTeam(){
  let h=`<div class="sec-head"><div><h2>Team</h2><p>People at ${esc(Store.firmName)} who can sign in. Each person needs their own login so the audit trail shows who did what. Deactivating someone signs them out at once; their past entries stay in the audit trail.</p></div></div>`+bannerHTML(false);
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.api('GET','members')}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='team')return;
  const used=list.filter(x=>x.active).length;
  h+=`<div class="panel"><h3>Invite someone</h3><p class="muted">${used} of ${Store.seats} seats in use. They get an email link to choose a password and set up two-step verification.</p>
    <div class="fields"><div class="f"><label for="invName">Name</label><input id="invName" autocomplete="off"></div><div class="f"><label for="invEmail">Email</label><input id="invEmail" type="email" autocomplete="off"></div>
    <div class="f"><label for="invRole">Role</label><select id="invRole"><option value="adviser">Adviser: works on client files</option><option value="admin">Administrator: also manages the team</option></select></div></div>
    <div class="addrow"><button class="btn primary" type="button" data-act="invite"${used>=Store.seats?' disabled':''}>Send invitation</button></div></div>`;
  h+=`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${x.role==='admin'?'Administrator':'Adviser'}</td><td><span class="pill ${x.active?'good':'neu'}">${x.active?'Active':'Deactivated'}</span></td><td>${x.email===Store.email?'<span class="muted">You</span>':`<button class="btn" type="button" data-act="memberActive" data-uid="${esc(x.userId)}" data-on="${x.active?'0':'1'}">${x.active?'Deactivate':'Reactivate'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#main').innerHTML=h;
}
