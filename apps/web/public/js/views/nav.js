/* Side rail: the household's sections with their counts and status, or the firm's pages when no household is open. */
import { Store } from '../api/store.js';
import { NAV_HELP } from '../content/help.js';
import { $, esc } from '../lib/dom.js';
import { isAdult } from '../lib/people.js';
import { state } from '../state.js';

const H = window.HWP; const { SCHEMA } = H;

export const NAV=[
  ['client','Client',[['household'],['members'],['income'],['expenses'],['goals'],['assumptions']]],
  ['wealth','Wealth',[['accounts'],['db'],['property'],['other'],['liabilities'],['protection']]],
  ['onboarding','Onboarding',[['compliance'],['rtq','Risk questionnaire'],['kyc','KYC status'],['audit','Audit trail']]],
  ['relationship','Relationship',[['contacts'],['actions'],['loas','Letters of authority'],['complaints'],['reviews','Reviews due']]],
  ['mandate','Mandate',[['mandate'],['models','Model portfolios'],['drift','Mandate check'],['perf','Fund performance']]],
  ['analysis','Analysis',[['bs','Balance sheet'],['scenarios','Life-event scenarios'],['tax','Tax and allowances'],['risk','Risk profile and IPS'],['checks','Data checks'],['guide','How the model works']]]];
export function renderNav(){
  if(FIRM_VIEWS.has(state.VIEW)){const fn=(Store.firm.settings&&Store.firm.settings.firm.name)||(typeof Store.firm==='string'?Store.firm:'')||'Firm';
    $('#rail').innerHTML=`<div class="ng open here"><div class="ng-h" style="cursor:default"><span class="ng-t">${esc(Store.firmName||fn)}</span></div><div class="ng-b">
      <button type="button" data-act="goClients" aria-current="${state.VIEW==='clients'}"><span>All households</span></button>
      <button type="button" data-act="tasks" aria-current="${state.VIEW==='tasks'}" title="Every open task across all households, by person"><span>Tasks</span></button>
      <button type="button" data-act="diary" aria-current="${state.VIEW==='diary'}" title="Every review, expiry, task and complaint deadline across all households"><span>Reviews due</span></button>
      <button type="button" data-act="firmSettings" aria-current="${state.VIEW==='firmSettings'}" title="Firm details, team members and providers"><span>Firm settings</span></button>
      ${Store.role==='admin'&&!Store.session?`<button type="button" data-act="team" aria-current="${state.VIEW==='team'}" title="Sign-in accounts"><span>User accounts</span></button>`:''}
      ${Store.session&&['admin','compliance'].includes(Store.role)?`<button type="button" data-act="records" aria-current="${state.VIEW==='records'}" title="Retention, purge requests, access logs and subject access exports"><span>Records and retention</span></button>`:''}
      ${Store.session?`<button type="button" data-act="account" aria-current="${state.VIEW==='account'}" title="Your password, authenticator app and sessions"><span>Account security</span></button>`:''}</div></div>`;
    $('#hhName').textContent={team:'User accounts',diary:'Reviews due across the firm',tasks:'Tasks across the firm',firmSettings:'Firm settings',account:'Account security'}[state.VIEW]||'Choose a household to open';return}
  const O=state.E.onboarding();const bad=state.E.checks().filter(x=>x.lvl==='bad').length;
  const badge=id=>{const s=SCHEMA[id];let ct='',cls='';if(s&&!s.single)ct=state.S[id].length||'';
    if(id==='checks'&&bad){ct=bad+' to fix';cls='bad'}
    if(id==='kyc'){ct=O.blockerCount?O.blockerCount+' open':O.stage;cls=O.blockerCount?'bad':''}
    if(id==='reviews'){const R=state.E.reviews(O);ct=R.overdue?R.overdue+' overdue':R.soon?R.soon+' due soon':'';cls=R.overdue?'bad':''}
    if(id==='actions'){const n=state.S.actions.filter(H.taskOpen).length;ct=n?n+' open':''}
    if(id==='rtq'){const ad=state.S.members.filter(isAdult);const done=ad.filter(m=>{const q=state.S.rtq.find(x=>x.owner===m.ref);return q&&H.rtqScore(q).complete}).length;ct=ad.length?done+'/'+ad.length:'';cls=done<ad.length?'warn':''}
    if(id==='drift'){const MC=state.E.mandateCheck();ct=MC.status;cls=MC.status==='Incomplete'?'bad':MC.status==='Drift'?'warn':''}
    return {ct,cls}};
  let h='';
  for(const [gid,gl,items] of NAV){const here=items.some(([id])=>id===state.VIEW);const open=here||NAV_OPEN.has(gid);
    const bs=items.map(([id])=>badge(id));const alerts=bs.filter(b=>b.cls==='bad').length;const warns=bs.filter(b=>b.cls==='warn').length;
    const gb=alerts?`<span class="ct bad">${alerts} alert${alerts>1?'s':''}</span>`:warns?`<span class="ct warn">review</span>`:'';
    h+=`<div class="ng${open?' open':''}${here?' here':''}"><button type="button" class="ng-h" data-act="navGroup" data-g="${gid}" aria-expanded="${open}"><span class="ng-chev">▸</span><span class="ng-t">${gl}</span>${open?'':gb}</button>`;
    if(open)h+=`<div class="ng-b">${items.map(([id,lbl],i)=>{const s=SCHEMA[id];const name=lbl||s.title;const b=bs[i];
      return `<button type="button" data-nav="${id}" aria-current="${state.VIEW===id}" title="${esc(NAV_HELP[id]||'')}"><span>${esc(name)}</span><span class="ct ${b.cls}">${esc(b.ct)}</span></button>`}).join('')}</div>`;
    h+=`</div>`}
  if(Store.mode!=='server')h+=`<div class="ng"><button type="button" class="ng-h" data-act="firmSettings"><span class="ng-t">Firm settings</span></button></div>`;
  $('#rail').innerHTML=h;
  $('#hhName').textContent=(state.S.household.name||'Unnamed household')+(state.S.household.reference?' · '+state.S.household.reference:'')+' · '+O.stage;
}
export const NAV_OPEN=new Set();
export const FIRM_VIEWS=new Set(['clients','team','diary','tasks','firmSettings','account','records']);
