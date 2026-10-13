/* Draws the current screen (state.VIEW): rail, top bar, then the screen itself. */
import { Store } from '../api/store.js';
import { $, esc } from '../lib/dom.js';
import { fmtDate } from '../lib/format.js';
import { state } from '../state.js';
import { renderAccount } from './account.js';
import { renderAudit } from './audit.js';
import { renderBS } from './balance-sheet.js';
import { renderChecks } from './checks.js';
import { renderClients } from './clients.js';
import { renderDiary } from './diary.js';
import { renderFirmSettings } from './firm-settings.js';
import { renderGuide } from './guide.js';
import { renderInput } from './input.js';
import { renderKyc } from './kyc.js';
import { renderLetter } from './letters.js';
import { renderDrift } from './mandate.js';
import { renderNav } from './nav.js';
import { bindPerfChart, renderPerf } from './performance.js';
import { renderRecords } from './records.js';
import { renderReviews } from './reviews.js';
import { renderRisk } from './risk.js';
import { renderScenarios } from './scenarios.js';
import { renderTasks } from './tasks.js';
import { renderTax } from './tax.js';
import { renderTeam } from './team.js';
import { renderTopbar } from './topbar.js';

const H = window.HWP; const { SCHEMA } = H;

// Screens the signed-in person can read but not change: the class hides the add / remove buttons, the note says why.
// (The fields are locked where they are drawn, components/form.js; the server refuses the change in any case.)
const LOCK_NOTE={
  firm:'You can read the firm settings. Only a firm administrator can change them.',
  household:'You can read this file. A compliance reviewer records the review sign-off (under Onboarding and compliance); everything else is changed by an adviser or an administrator.',
  signoff:'The review sign-off (reviewer, review date, outcome and notes) is recorded by a compliance reviewer, not on this screen.'};
function lockOf(){if(!Store.session)return null;
  if(state.VIEW==='firmSettings')return Store.canEditFirm()?null:'firm';
  if(!SCHEMA[state.VIEW])return null;
  if(!Store.canEditHousehold())return 'household';
  return state.VIEW==='compliance'&&!Store.canSignOff()?'signoff':null}
const lockNote=lock=>`<p class="note ro-note lock-note" role="note">${LOCK_NOTE[lock]}</p>`;
// Who signed the file off, and, when the onboarding assessment has changed since, that the sign-off is out of date.
// It sits at the top of the screens it concerns; it is refreshed in place after a save (no redraw, so nobody loses their place).
const REVIEW_VIEWS=new Set(['compliance','kyc']);
function reviewNote(){const r=Store.session&&Store.id&&REVIEW_VIEWS.has(state.VIEW)?Store.review:null;if(!r)return '';
  const when=fmtDate(String(r.at).slice(0,10));
  return Store.reviewStale?`<div class="banner bad" role="status"><div><b>The sign-off is out of date.</b> ${esc(r.by)} signed this file off on ${when} (version ${r.version}). The file has changed since, and the onboarding assessment is different now. A compliance reviewer needs to review it again.</div></div>`
    :`<p class="note ro-note review-note" role="status">Signed off by <b>${esc(r.by)}</b> on ${when} (version ${r.version}). The sign-off is current.</p>`}
const reviewHolder=()=>`<div id="reviewNote">${reviewNote()}</div>`;
document.addEventListener('hwp-review',()=>{const el=document.getElementById('reviewNote');if(el)el.innerHTML=reviewNote()});

export function render(){
  renderNav();renderTopbar();const m=$('#main');const lock=lockOf();m.classList.toggle('ro',lock==='firm'||lock==='household');
  if(state.VIEW==='clients')return renderClients();
  if(state.VIEW==='team')return renderTeam();
  if(state.VIEW==='diary')return renderDiary();
  if(state.VIEW==='tasks')return renderTasks();
  if(state.VIEW==='firmSettings'){m.innerHTML=renderFirmSettings();if(lock)m.insertAdjacentHTML('afterbegin',lockNote(lock));return}
  if(state.VIEW==='account')return renderAccount();
  if(state.VIEW==='records')return renderRecords();
  if(state.VIEW==='audit')return renderAudit();
  if(SCHEMA[state.VIEW])m.innerHTML=renderInput(state.VIEW);else if(state.VIEW==='bs')m.innerHTML=renderBS();else if(state.VIEW==='tax')m.innerHTML=renderTax();else if(state.VIEW==='risk')m.innerHTML=renderRisk();else if(state.VIEW==='kyc')m.innerHTML=renderKyc();else if(state.VIEW==='guide')m.innerHTML=renderGuide();else if(state.VIEW==='reviews')m.innerHTML=renderReviews();else if(state.VIEW==='drift')m.innerHTML=renderDrift();else if(state.VIEW==='letter')m.innerHTML=renderLetter();else if(state.VIEW==='scenarios')m.innerHTML=renderScenarios();else if(state.VIEW==='perf'){m.innerHTML=renderPerf();bindPerfChart()}else m.innerHTML=renderChecks();
  if(lock)m.insertAdjacentHTML('afterbegin',lockNote(lock));
  if(REVIEW_VIEWS.has(state.VIEW))m.insertAdjacentHTML('afterbegin',reviewHolder());
}
