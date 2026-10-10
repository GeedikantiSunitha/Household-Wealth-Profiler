/* Side rail: the household's sections with their counts and status, or the firm's pages when no household is open. */
import { Store } from '../api/store.js';
import { NAV_HELP } from '../content/help.js';
import { $, esc } from '../lib/dom.js';
import { state } from '../state.js';

const H = window.HWP; const { SCHEMA } = H;

export const NAV=[
  ['Client data',[['household'],['members'],['income'],['expenses'],['goals'],['accounts'],['db'],['property'],['other'],['liabilities'],['protection'],['assumptions']]],
  ['Onboarding',[['compliance'],['kyc','KYC and onboarding status'],['audit','Audit trail']]],
  ['Relationship',[['contacts'],['actions'],['complaints'],['reviews','Reviews due']]],
  ['Mandate',[['mandate'],['models','Model portfolios'],['drift','Mandate check']]],
  ['Outputs',[['bs','Economic balance sheet'],['tax','Tax and allowances'],['risk','Risk profile and IPS'],['checks','Data checks'],['guide','How the model works']]]];
export function renderNav(){
  if(state.VIEW==='clients'||state.VIEW==='team'||state.VIEW==='diary'){$('#rail').innerHTML=`<h6>${esc(Store.firm||'Clients')}</h6><button type="button" data-act="goClients" aria-current="${state.VIEW==='clients'}"><span>All households</span></button><button type="button" data-act="diary" aria-current="${state.VIEW==='diary'}" title="Every review, expiry, action and complaint deadline across all households"><span>Reviews due</span></button>${Store.role==='admin'?`<button type="button" data-act="team" aria-current="${state.VIEW==='team'}"><span>Team</span></button>`:''}`;$('#hhName').textContent=state.VIEW==='team'?'Team and access':state.VIEW==='diary'?'Reviews due across the firm':'Choose a household to open';return}
  let h='';let step=0;const O=state.E.onboarding();const bad=state.E.checks().filter(x=>x.lvl==='bad').length;
  for(const [sec,items] of NAV){h+=`<h6>${sec}</h6>`;for(const [id,lbl] of items){const s=SCHEMA[id];const name=lbl||s.title;
    let ct='',cls='';if(s&&!s.single)ct=state.S[id].length;
    if(id==='checks'&&bad){ct=bad+' to fix';cls='bad'}
    if(id==='kyc'){ct=O.blockerCount?O.blockerCount+' open':O.stage;cls=O.blockerCount?'bad':''}
    if(id==='reviews'){const R=state.E.reviews(O);ct=R.overdue?R.overdue+' overdue':R.soon?R.soon+' due soon':'';cls=R.overdue?'bad':''}
    if(id==='actions'){const n=state.S.actions.filter(a=>a.status==='Open').length;ct=n?n+' open':''}
    if(id==='drift'){const MC=state.E.mandateCheck();ct=MC.status;cls=MC.status==='Incomplete'?'bad':''}
    const st=s&&sec==='Client data'?`<span class="step">${String(++step).padStart(2,'0')}</span>`:'';
    h+=`<button type="button" data-nav="${id}" aria-current="${state.VIEW===id}" title="${esc(NAV_HELP[id]||'')}"><span>${st}${esc(name)}</span><span class="ct ${cls}">${esc(ct)}</span></button>`}}
  $('#rail').innerHTML=h;
  $('#hhName').textContent=(state.S.household.name||'Unnamed household')+(state.S.household.reference?' · '+state.S.household.reference:'')+' · '+O.stage;
}
