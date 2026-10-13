/* Draws the current screen (state.VIEW): rail, top bar, then the screen itself. */
import { $ } from '../lib/dom.js';
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
import { renderReviews } from './reviews.js';
import { renderRisk } from './risk.js';
import { renderScenarios } from './scenarios.js';
import { renderTasks } from './tasks.js';
import { renderTax } from './tax.js';
import { renderTeam } from './team.js';
import { renderTopbar } from './topbar.js';

const H = window.HWP; const { SCHEMA } = H;

export function render(){
  renderNav();renderTopbar();const m=$('#main');
  if(state.VIEW==='clients')return renderClients();
  if(state.VIEW==='team')return renderTeam();
  if(state.VIEW==='diary')return renderDiary();
  if(state.VIEW==='tasks')return renderTasks();
  if(state.VIEW==='firmSettings'){m.innerHTML=renderFirmSettings();return}
  if(state.VIEW==='account')return renderAccount();
  if(state.VIEW==='audit')return renderAudit();
  if(SCHEMA[state.VIEW])m.innerHTML=renderInput(state.VIEW);else if(state.VIEW==='bs')m.innerHTML=renderBS();else if(state.VIEW==='tax')m.innerHTML=renderTax();else if(state.VIEW==='risk')m.innerHTML=renderRisk();else if(state.VIEW==='kyc')m.innerHTML=renderKyc();else if(state.VIEW==='guide')m.innerHTML=renderGuide();else if(state.VIEW==='reviews')m.innerHTML=renderReviews();else if(state.VIEW==='drift')m.innerHTML=renderDrift();else if(state.VIEW==='letter')m.innerHTML=renderLetter();else if(state.VIEW==='scenarios')m.innerHTML=renderScenarios();else if(state.VIEW==='perf'){m.innerHTML=renderPerf();bindPerfChart()}else m.innerHTML=renderChecks();
}
