/* Every button and link on the page (data-nav and data-act): moving between screens, adding, removing and undoing records, opening and creating households, reloading after a conflict, team invitations, and the start-again controls. Enter or Space on a card heading opens it. */
import { Store, logChange } from '../api/store.js';
import { summary } from '../components/form.js';
import { IMPACT } from '../components/impact.js';
import { $, esc, toast } from '../lib/dom.js';
import { FIRM_KEYS, recs } from '../lib/firm.js';
import { fmtYM } from '../lib/format.js';
import { isAdult } from '../lib/people.js';
import { setState, state } from '../state.js';
import { NAV, NAV_OPEN, renderNav } from '../views/nav.js';
import { PERF } from '../views/performance.js';
import { render } from '../views/render.js';
import { TASKF } from '../views/tasks.js';

const H = window.HWP; const { SCHEMA, fieldsOf } = H;

let creating=false; // a create in flight (see newBlank / newSample)
export function resetUI(confirming){$('#resetWrap').innerHTML=confirming?`<span class="confirm"><span class="muted" style="font-size:12.5px">Clear all data?</span><button class="btn primary" type="button" data-act="confirmReset">Clear</button><button class="btn" type="button" data-act="loadSample">Load sample</button><button class="btn ghost" type="button" data-act="cancelReset">Cancel</button></span>`:`<button class="btn ghost" id="btnReset" type="button">Start blank</button>`;
  if(!confirming)$('#btnReset').onclick=()=>resetUI(true)}
document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-nav]');if(nav&&nav.dataset.nav){state.VIEW=nav.dataset.nav;if(state.banner&&!state.banner.sticky)state.banner=null;render();window.scrollTo({top:0});return}
  const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act,col=b.dataset.col,idx=+b.dataset.idx;
  if(act==='del'&&FIRM_KEYS.has(col)){e.stopPropagation();const rem=recs(col).splice(idx,1)[0];Store.touchFirm();state.banner={html:`Removed ${esc(summary(col,rem)[0])}. <button class="btn" type="button" data-act="undo">Undo</button>`,undo:{col,idx,rem,firm:true}};render();return}
  if(act==='del'){e.stopPropagation();const rem=state.S[col].splice(idx,1)[0];logChange(`${col}.count`,state.S[col].length+1,state.S[col].length);Store.touch();
    state.banner={html:`Removed ${esc(summary(col,rem)[0])}. <button class="btn" type="button" data-act="undo">Undo</button>`,undo:{col,idx,rem}};IMPACT.why=`<b>${esc(SCHEMA[col].item)} removed.</b> The figures above compare with when you opened this section.`;render();return}
  if(act==='undo'&&state.banner&&state.banner.undo&&state.banner.undo.firm){const u=state.banner.undo;recs(u.col).splice(u.idx,0,u.rem);state.banner=null;Store.touchFirm();render();return}
  if(act==='undo'&&state.banner&&state.banner.undo){const u=state.banner.undo;state.S[u.col].splice(u.idx,0,u.rem);logChange(`${u.col}.count`,state.S[u.col].length-1,state.S[u.col].length);state.banner=null;Store.touch();render();return}
  if(act==='closeBanner'){state.banner=null;render();return}
  if(act==='navGroup'){const g=b.dataset.g;const grp=NAV.find(x=>x[0]===g);if(grp.some(([id])=>id===state.VIEW))return;NAV_OPEN.has(g)?NAV_OPEN.delete(g):NAV_OPEN.add(g);renderNav();return}
  if(['goClients','team','diary','tasks','firmSettings'].includes(act)){await Store.flush();state.VIEW=act==='goClients'?'clients':act;state.banner=null;render();return}
  if(act==='signOut'){await Store.flush();if(Store.dirty||Store.err){toast('Changes are not saved yet. Try again in a moment.');return}await Store.cloud.signOut();location.reload();return}
  if(act==='invite'){const body={name:$('#invName').value.trim(),email:$('#invEmail').value.trim(),role:$('#invRole').value};b.disabled=true;
    try{await Store.api('POST','members',body);state.banner={cls:'good',html:`Invitation sent to ${esc(body.email)}.`}}catch(err){state.banner={cls:'bad',html:esc(err.message)}}render();return}
  if(act==='memberActive'){try{await Store.api('PATCH','members/'+encodeURIComponent(b.dataset.uid),{active:b.dataset.on==='1'});state.banner=null}catch(err){state.banner={cls:'bad',html:esc(err.message)}}render();return}
  if(act==='toggle'){if(e.target.closest('[data-act="del"]'))return;const key=col+':'+idx;state.OPEN.has(key)?state.OPEN.delete(key):state.OPEN.add(key);const card=b.closest('.card');card.dataset.open=state.OPEN.has(key);b.setAttribute('aria-expanded',state.OPEN.has(key));return}
  if(act==='toggleAll'&&FIRM_KEYS.has(col)){const L=recs(col);const all=L.every((_,i)=>state.OPEN.has(col+':'+i));L.forEach((_,i)=>all?state.OPEN.delete(col+':'+i):state.OPEN.add(col+':'+i));render();return}
  if(act==='toggleAll'){const all=state.S[col].every((_,i)=>state.OPEN.has(col+':'+i));state.S[col].forEach((_,i)=>all?state.OPEN.delete(col+':'+i):state.OPEN.add(col+':'+i));render();return}
  if(act==='add'&&FIRM_KEYS.has(col)){recs(col).push(H.defaults(col));state.OPEN.add(col+':'+(recs(col).length-1));Store.touchFirm();render();return}
  if(act==='fundImport'){const i=+b.dataset.idx;const inp=document.createElement('input');inp.type='file';inp.accept='.csv,.txt,text/csv';
    inp.onchange=async()=>{const f=inp.files[0];if(!f)return;try{const r=H.parsePriceCSV(await f.text());const fund=Store.firm.settings.funds[i];fund.prices=H.seriesEncode(r.series);fund.pricesUpdated=H.today();Store.touchFirm();
      state.banner={cls:'good',html:`Imported ${r.series.length} monthly prices for ${esc(fund.name||'the fund')} from the <b>${esc(r.column)}</b> column (${fmtYM(r.series[0].d)} to ${fmtYM(r.series[r.series.length-1].d)})${r.skipped?`; ${r.skipped} row(s) skipped`:''}.`}}
      catch(err){state.banner={cls:'bad',html:esc(err.message)}}render()};inp.click();return}
  if(act==='fundFetch'){const i=+b.dataset.idx;const fund=Store.firm.settings.funds[i];b.disabled=true;b.textContent='Fetching…';
    try{const j=await Store.api('GET','prices?symbol='+encodeURIComponent(fund.ticker));const r=H.parsePriceCSV(j.csv);fund.prices=H.seriesEncode(r.series);fund.pricesUpdated=H.today();if(!fund.source)fund.source='Alpha Vantage, adjusted close';Store.touchFirm();
      state.banner={cls:'good',html:`Fetched ${r.series.length} monthly prices for ${esc(fund.name||fund.ticker)}.`}}catch(err){state.banner={cls:'bad',html:esc(err.message)}}render();return}
  if(act==='perfPick'){const n=b.dataset.name;PERF.sel.has(n)?PERF.sel.delete(n):PERF.sel.size<5&&PERF.sel.add(n);PERF.touched=true;render();return}
  if(act==='perfPeriod'){PERF.period=b.dataset.v;render();return}
  if(act==='scenSel'){state.SCEN_SEL=b.dataset.id;render();return}
  if(act==='rtqStart'){const r=Object.assign(H.defaults('rtq'),{owner:b.dataset.ref,by:Store.user||''});state.S.rtq.push(r);logChange('rtq.count',state.S.rtq.length-1,state.S.rtq.length);state.OPEN.add('rtq:'+(state.S.rtq.length-1));Store.touch();render();return}
  if(act==='loaLetter'){e.stopPropagation();state.LOA_IDX=+b.dataset.idx;state.VIEW='letter';state.banner=null;render();window.scrollTo({top:0});return}
  if(act==='print'){window.print();return}
  if(act==='reloadFirm'){state.banner=null;Store.firm.err=null;await Store.loadFirm();render();return}
  if(act==='taskFilter'){TASKF[b.dataset.k]=b.dataset.v;render();return}
  if(act==='add'){const r=H.defaults(col);if(col==='members'){const ad=state.S.members.filter(isAdult).length;r.ref=ad<1?'P1':ad<2?'P2':'C'+(state.S.members.filter(m=>m.role==='child').length+1);r.role=ad<1?'primary':ad<2?'partner':'child'}
    else if(['income','db','protection'].includes(col))r.owner=state.S.members[0]?.ref||'';else if(fieldsOf(SCHEMA[col]).some(f=>f.t==='owner'))r.owner=state.S.members.filter(isAdult).length>1?'JOINT':(state.S.members[0]?.ref||'');
    state.S[col].push(r);logChange(`${col}.count`,state.S[col].length-1,state.S[col].length);state.OPEN.add(col+':'+(state.S[col].length-1));Store.touch();IMPACT.why=`<b>${esc(SCHEMA[col].item)} added.</b> Fill it in and the figures above update as you type.`;render();const cards=document.querySelectorAll('.card');cards[cards.length-1]?.scrollIntoView({behavior:'smooth',block:'center'});return}
  if(act==='bsview'){state.BSVIEW=b.dataset.v;render();return}
  if(act==='resetAssump'){state.S.assumptions=H.defaults('assumptions');logChange('assumptions','edited','defaults restored');Store.touch();render();toast('Assumptions restored to 2026/27 defaults');return}
  if(act==='confirmReset'){setState(H.blank());state.S.household.name='';state.OPEN.clear();state.OPEN.add('members:0');Store.saveLocal();state.VIEW='household';resetUI(false);render();toast('Started a blank household');return}
  if(act==='loadSample'){setState(H.sample());Store.saveLocal();resetUI(false);render();toast('Sample household loaded');return}
  if(act==='cancelReset'){resetUI(false);return}
  if(act==='openHousehold'){try{await Store.open(b.dataset.id);state.banner=null;state.VIEW=b.dataset.view||'kyc';state.OPEN.clear();state.OPEN.add('members:0');render()}catch(err){toast('Could not open the household: '+err.message)}return}
  if(act==='newBlank'||act==='newSample'){if(creating)return;creating=true;b.disabled=true; // a second click while the first create is in flight does nothing
    try{const st=act==='newSample'?H.sample():H.blank();st.isSample=act==='newSample';await Store.create(st);setState(H.normalise(st));state.VIEW='household';state.banner=null;render()}catch(err){toast('Could not create the household: '+err.message)}
    finally{creating=false;b.disabled=false}return}
  if(act==='reloadHousehold'){try{await Store.open(Store.id);Store.err=null;state.banner=null;render();toast('Loaded the latest version')}catch(err){toast(err.message)}return}
});
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.card-h')){e.preventDefault();e.target.click()}});
