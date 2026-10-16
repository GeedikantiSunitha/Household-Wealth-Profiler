/* Data checks: gaps and inconsistencies found by the rules. */
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { state } from '../hooks/state.js';

export function renderChecks(){const list=state.E.checks();
  let h=`<div class="sec-head"><div><h2>Data checks</h2><p>Completeness and consistency tests run on every change. Fix the items marked Action before relying on the outputs.</p></div></div>`+bannerHTML();
  h+=`<div class="panel"><ul class="list">${list.length?list.map(c=>`<li><span class="pill ${c.lvl==='bad'?'bad':'warn'}">${c.lvl==='bad'?'Action':'Review'}</span><span class="grow">${esc(c.msg)}</span><button class="btn" type="button" data-nav="${c.where}">Open</button></li>`).join(''):'<li><span class="pill good">Clear</span><span>No issues found.</span></li>'}</ul></div>`;return h}
