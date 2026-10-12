/* Audit trail: who changed which field, when, from what to what. */
import { Store } from '../api/store.js';
import { bannerHTML } from '../components/banner.js';
import { $, esc } from '../lib/dom.js';
import { fmtTs } from '../lib/format.js';
import { state } from '../state.js';

const H = window.HWP; const { SCHEMA, fieldsOf } = H;

export async function renderAudit(){
  let h=`<div class="sec-head"><div><h2>Audit trail</h2><p>${Store.mode==='server'?'Every saved change, recorded by the server with the signed-in user and time. Entries cannot be edited from this screen.':'Changes made in this browser. Run the server version for a tamper-resistant trail with named logins.'}</p></div></div>`+bannerHTML();
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let rows=[];try{rows=await Store.audit()}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>Could not load the audit trail. ${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='audit')return;
  const lab=p=>{const m=/^(\w+)(?:\[(\d+)\])?\.(\w+)$/.exec(p);if(!m)return p;const [,sec,i,k]=m;const s=SCHEMA[sec];if(!s)return p;if(k==='count')return `${s.title}: number of records`;const f=fieldsOf(s).find(x=>x.k===k);return `${s.title}${i!==undefined?' #'+(+i+1):''}: ${f?f.l:k}`};
  h+=`<div class="panel">${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th><th>To</th></tr></thead><tbody>${rows.slice(0,1000).map(r=>`<tr><td style="white-space:nowrap">${esc(fmtTs(r.ts))}</td><td>${esc(r.user)}</td><td>${esc(r.field==='created'?'Household created':r.field==='import'?'Imported a file':lab(r.field))}</td><td class="mono">${esc(r.from)}</td><td class="mono">${esc(r.to)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No changes recorded yet.</p>'}</div>`;
  $('#main').innerHTML=h;
}
