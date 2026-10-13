/* User accounts: the people who can sign in to the firm, their roles, invitations and seats. Administrators only (the server refuses anyone else).
   The server's reply is { members, seats, used }; the older Supabase edition answers with a plain list and sends the seats with /me. */
import { Store } from '../api/store.js';
import { bannerHTML } from '../components/banner.js';
import { $, esc } from '../lib/dom.js';
import { state } from '../state.js';

const ROLE_LABEL={admin:'Administrator',adviser:'Adviser',compliance:'Compliance reviewer'};
const ROLE_HELP={admin:'Administrator: works on client files, changes the firm settings and manages the team',adviser:'Adviser: works on client files',compliance:'Compliance reviewer: reads every file and records the review sign-off'};
// One or several roles per person: a person can do whatever any of their roles allows
const boxes=(name,chosen,attrs='')=>Object.keys(ROLE_LABEL).map(r=>`<label class="chk-inline"><input type="checkbox" name="${name}" value="${r}"${chosen.includes(r)?' checked':''}${attrs}> ${esc(ROLE_LABEL[r])}</label>`).join(' ');
const statusOf=x=>x.invitation==='pending'?['warn','Invitation pending']:x.invitation==='declined'?['neu','Declined']:!x.active?['neu','Deactivated']:x.hasPassword===false?['warn','Invited']:['good','Active'];
const rolesOf=x=>x.roles&&x.roles.length?x.roles:[x.role];

export async function renderTeam(){
  let h=`<div class="sec-head"><div><h2>User accounts</h2><p>People at ${esc(Store.firmName)} who can sign in. Each person needs their own account so the audit trail shows who did what. A change of role applies at once, and deactivating someone signs them out at once; their past entries stay in the audit trail.</p></div></div>`+bannerHTML(false);
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let reply;try{reply=await Store.api('GET','members')}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='team')return;
  const list=Array.isArray(reply)?reply:reply.members;
  const seats=reply.seats!=null?reply.seats:Store.seats;
  const used=reply.used!=null?reply.used:list.filter(x=>x.active).length;
  h+=`<div class="panel"><h3>Invite someone</h3><p class="muted">${used} of ${seats} seats in use. They get an email link to choose a password, then set up two-step verification at their first sign-in. Someone who already has an account with us is added to this firm and told by email.</p>
    <div class="fields"><div class="f"><label for="invName">Name</label><input id="invName" autocomplete="off"></div><div class="f"><label for="invEmail">Email</label><input id="invEmail" type="email" autocomplete="off"></div>
    <div class="f wide"><span class="lab" id="invRolesLab">Roles</span><div id="invRoles" role="group" aria-labelledby="invRolesLab">${boxes('invRole',['adviser'])}</div></div></div>
    <ul class="muted" style="margin:10px 0 0;padding-left:18px">${Object.keys(ROLE_HELP).map(r=>`<li>${esc(ROLE_HELP[r])}</li>`).join('')}<li>Tick more than one when someone does more than one job. Nobody can sign off a file they have worked on, whatever their roles.</li></ul>
    <div class="addrow"><button class="btn primary" type="button" data-act="invite"${used>=seats?' disabled':''}>Send invitation</button></div></div>`;
  const row=x=>{const self=x.email===Store.email;const [cls,label]=statusOf(x);
    // The app's own sign-in changes roles in place (tick or untick); the Supabase edition has two fixed roles shown as text
    const roleCell=self||!Store.session?esc(rolesOf(x).map(r=>ROLE_LABEL[r]||r).join(' + ')):`<div role="group" aria-label="Roles of ${esc(x.name||x.email)}">${boxes('role-'+x.userId,rolesOf(x),` data-act="memberRoles" data-uid="${esc(x.userId)}"`)}</div>`;
    return `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${roleCell}</td><td><span class="pill ${cls}">${label}</span></td><td>${self?'<span class="muted">You</span>':`<button class="btn" type="button" data-act="memberActive" data-uid="${esc(x.userId)}" data-on="${x.active?'0':'1'}">${x.active?'Deactivate':x.invitation==='declined'?'Invite again':'Reactivate'}</button>`}</td></tr>`};
  h+=`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div></div>`;
  $('#main').innerHTML=h;
}
