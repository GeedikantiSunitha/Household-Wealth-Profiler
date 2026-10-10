/* Household Wealth Profiler: user interface.
   Uses window.HWP (core.js) for every calculation.
   Runs in two modes:
   - server: talks to server.js (logins, encrypted storage, versions, audit trail)
   - cloud:  the Supabase edition (config.js sets supabaseUrl); same as server mode, but signs in
             through cloud.js and calls the `api` Edge Function with a bearer token
   - local:  no server found; drafts stay in this browser only */
import { state, setState } from './state.js';
import { $, esc, toast } from './lib/dom.js';
import { Store, logChange, LS_USER, setRenderer } from './api/store.js';
import { memberName, isAdult } from './lib/people.js';
import { VALIDATE, summary } from './components/form.js';
import { IMPACT, refreshImpact } from './components/impact.js';
import { renderNav } from './views/nav.js';
import { GROUPS_A, GROUPS_L } from './views/balance-sheet.js';
import { render } from './views/render.js';

(function(){
'use strict';
setRenderer(()=>render());
const H=window.HWP;
const {SCHEMA,COLS,SINGLES,YN,ROLES,WGROUP,EXP_CATS,ASSET_CLASSES,ROLLUP,fieldsOf,optList,N,has,yes}=H;

/* Where the rest of the interface lives:
     state.js        shared state (the open household, the screen on show, open cards, the banner)
     api/store.js    saving: the server connection, autosave, edit conflicts, the save status
     lib/            page helpers, number and date formats, people in the household
     content/        help text and "how this section is used" text
     components/     form fields, the banner, the how-it-is-used panel, the live-effect panel
     views/          one file per screen; views/render.js draws the screen on show
   This file still holds editing, button handling, Excel/JSON and start-up (moved in steps B19-B20). */

// Timer for refreshing the live-effect panel while the adviser types (see onEdit)
let impT;

/* ---------- editing ---------- */
function parseVal(f,raw,el){if(f.t===YN)return el?el.checked:raw;if(f.t==='num'||f.t==='pct'||f.t==='int'){if(raw===''||raw==null)return '';const n=parseFloat(String(raw).replace(/[£,%\s]/g,''));return isFinite(n)?n:''}return raw}
let navT;
function onEdit(e){const el=e.target;
  if(el.id==='whoIn'){Store.user=el.value.trim();try{localStorage.setItem(LS_USER,Store.user)}catch(x){}return}
  if(!el.dataset||!el.dataset.k)return;const {col,idx,k}=el.dataset;const s=SCHEMA[col];const f=fieldsOf(s).find(x=>x.k===k);
  const v=parseVal(f,el.value,el.type==='checkbox'?el:null);const rec=s.single?state.S[col]:state.S[col][+idx];const old=rec[k];if(old===v)return;rec[k]=v;
  logChange(s.single?`${col}.${k}`:`${col}[${idx}].${k}`,old,v);Store.touch();
  clearTimeout(impT);impT=setTimeout(()=>refreshImpact(`${s.title}: ${f.l}`,f),120);
  if(VALIDATE[k]){const msg=VALIDATE[k](v);const h=document.getElementById(el.id+'-h');el.setAttribute('aria-invalid',msg?'true':'false');if(h){h.textContent=msg||f.h||'';h.className='hint'+(msg?' err':'')}}
  if(!s.single){const card=document.querySelector(`[data-card="${col}:${idx}"]`);if(card){const [t,meta,val]=summary(col,rec);card.querySelector('.sum').innerHTML=`<b>${esc(t)}</b><span class="meta">${esc(meta)}</span>`;card.querySelector('.val').textContent=val}}
  clearTimeout(navT);navT=setTimeout(renderNav,250);
  if(col==='members'&&k==='role'&&e.type==='change')render();
}
document.addEventListener('input',onEdit);document.addEventListener('change',onEdit);
document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-nav]');if(nav&&nav.dataset.nav){state.VIEW=nav.dataset.nav;if(state.banner&&!state.banner.sticky)state.banner=null;render();window.scrollTo({top:0});return}
  const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act,col=b.dataset.col,idx=+b.dataset.idx;
  if(act==='del'){e.stopPropagation();const rem=state.S[col].splice(idx,1)[0];logChange(`${col}.count`,state.S[col].length+1,state.S[col].length);Store.touch();
    state.banner={html:`Removed ${esc(summary(col,rem)[0])}. <button class="btn" type="button" data-act="undo">Undo</button>`,undo:{col,idx,rem}};IMPACT.why=`<b>${esc(SCHEMA[col].item)} removed.</b> The figures above compare with when you opened this section.`;render();return}
  if(act==='undo'&&state.banner&&state.banner.undo){const u=state.banner.undo;state.S[u.col].splice(u.idx,0,u.rem);logChange(`${u.col}.count`,state.S[u.col].length-1,state.S[u.col].length);state.banner=null;Store.touch();render();return}
  if(act==='closeBanner'){state.banner=null;render();return}
  if(act==='goClients'||act==='team'||act==='diary'){await Store.flush();state.VIEW=act==='goClients'?'clients':act;state.banner=null;render();return}
  if(act==='signOut'){await Store.flush();if(Store.dirty||Store.err){toast('Changes are not saved yet. Try again in a moment.');return}await Store.cloud.signOut();location.reload();return}
  if(act==='invite'){const body={name:$('#invName').value.trim(),email:$('#invEmail').value.trim(),role:$('#invRole').value};b.disabled=true;
    try{await Store.api('POST','members',body);state.banner={cls:'good',html:`Invitation sent to ${esc(body.email)}.`}}catch(err){state.banner={cls:'bad',html:esc(err.message)}}render();return}
  if(act==='memberActive'){try{await Store.api('PATCH','members/'+encodeURIComponent(b.dataset.uid),{active:b.dataset.on==='1'});state.banner=null}catch(err){state.banner={cls:'bad',html:esc(err.message)}}render();return}
  if(act==='toggle'){if(e.target.closest('[data-act="del"]'))return;const key=col+':'+idx;state.OPEN.has(key)?state.OPEN.delete(key):state.OPEN.add(key);const card=b.closest('.card');card.dataset.open=state.OPEN.has(key);b.setAttribute('aria-expanded',state.OPEN.has(key));return}
  if(act==='toggleAll'){const all=state.S[col].every((_,i)=>state.OPEN.has(col+':'+i));state.S[col].forEach((_,i)=>all?state.OPEN.delete(col+':'+i):state.OPEN.add(col+':'+i));render();return}
  if(act==='add'){const r=H.defaults(col);if(col==='members'){const ad=state.S.members.filter(isAdult).length;r.ref=ad<1?'P1':ad<2?'P2':'C'+(state.S.members.filter(m=>m.role==='child').length+1);r.role=ad<1?'primary':ad<2?'partner':'child'}
    else if(['income','db','protection'].includes(col))r.owner=state.S.members[0]?.ref||'';else if(fieldsOf(SCHEMA[col]).some(f=>f.t==='owner'))r.owner=state.S.members.filter(isAdult).length>1?'JOINT':(state.S.members[0]?.ref||'');
    state.S[col].push(r);logChange(`${col}.count`,state.S[col].length-1,state.S[col].length);state.OPEN.add(col+':'+(state.S[col].length-1));Store.touch();IMPACT.why=`<b>${esc(SCHEMA[col].item)} added.</b> Fill it in and the figures above update as you type.`;render();const cards=document.querySelectorAll('.card');cards[cards.length-1]?.scrollIntoView({behavior:'smooth',block:'center'});return}
  if(act==='bsview'){state.BSVIEW=b.dataset.v;render();return}
  if(act==='resetAssump'){state.S.assumptions=H.defaults('assumptions');logChange('assumptions','edited','defaults restored');Store.touch();render();toast('Assumptions restored to 2026/27 defaults');return}
  if(act==='confirmReset'){setState(H.blank());state.S.household.name='';state.OPEN.clear();state.OPEN.add('members:0');Store.saveLocal();state.VIEW='household';resetUI(false);render();toast('Started a blank household');return}
  if(act==='loadSample'){setState(H.sample());Store.saveLocal();resetUI(false);render();toast('Sample household loaded');return}
  if(act==='cancelReset'){resetUI(false);return}
  if(act==='openHousehold'){try{await Store.open(b.dataset.id);state.banner=null;state.VIEW=b.dataset.view||'kyc';state.OPEN.clear();state.OPEN.add('members:0');render()}catch(err){toast('Could not open the household: '+err.message)}return}
  if(act==='newBlank'||act==='newSample'){try{const st=act==='newSample'?H.sample():H.blank();st.isSample=act==='newSample';await Store.create(st);setState(H.normalise(st));state.VIEW='household';state.banner=null;render()}catch(err){toast('Could not create the household: '+err.message)}return}
  if(act==='reloadHousehold'){try{await Store.open(Store.id);Store.err=null;state.banner=null;render();toast('Loaded the latest version')}catch(err){toast(err.message)}return}
});
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.card-h')){e.preventDefault();e.target.click()}});
function resetUI(confirming){$('#resetWrap').innerHTML=confirming?`<span class="confirm"><span class="muted" style="font-size:12.5px">Clear all data?</span><button class="btn primary" type="button" data-act="confirmReset">Clear</button><button class="btn" type="button" data-act="loadSample">Load sample</button><button class="btn ghost" type="button" data-act="cancelReset">Cancel</button></span>`:`<button class="btn ghost" id="btnReset" type="button">Start blank</button>`;
  if(!confirming)$('#btnReset').onclick=()=>resetUI(true)}

/* ---------- Excel and JSON ---------- */
let xlsxP=null;
function loadXLSX(){if(window.XLSX)return Promise.resolve(window.XLSX);if(xlsxP)return xlsxP;
  const tryLoad=src=>new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=()=>window.XLSX?res(window.XLSX):rej();s.onerror=rej;document.head.appendChild(s)});
  xlsxP=tryLoad('vendor/xlsx.full.min.js').catch(()=>tryLoad('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js')).catch(()=>{xlsxP=null;throw new Error('The spreadsheet reader could not be loaded. Check your connection and try again.')});
  return xlsxP}
function readSheet(XLSX,ws){const rows=[];if(!ws||!ws['!ref'])return rows;const R=XLSX.utils.decode_range(ws['!ref']);
  for(let r=R.s.r;r<=Math.min(R.e.r,R.s.r+5000);r++){const row=[];for(let c=R.s.c;c<=Math.min(R.e.c,R.s.c+80);c++){const cell=ws[XLSX.utils.encode_cell({r,c})];row.push(cell?{v:cell.v,z:cell.z}:null)}rows.push(row)}return rows}
function importWorkbook(XLSX,wb){
  const ns=H.normalise(JSON.parse(JSON.stringify(state.S)));delete ns.audit;
  const report=[];const sheets={};wb.SheetNames.forEach(n=>sheets[H.normKey(n)]=wb.Sheets[n]);let found=0;
  for(const key of SINGLES){const ws=sheets[H.normKey(SCHEMA[key].sheet)];if(!ws)continue;found++;const rows=readSheet(XLSX,ws);const fs=fieldsOf(SCHEMA[key]);let n=0;
    for(const row of rows){if(!row[0])continue;const f=fs.find(x=>H.normKey(x.k)===H.normKey(row[0].v)||H.normKey(x.l)===H.normKey(row[0].v));if(!f||!row[1])continue;ns[key][f.k]=H.coerce(f,row[1].v,row[1]);n++}
    report.push(`${SCHEMA[key].title}: ${n} fields`)}
  for(const key of COLS){const ws=sheets[H.normKey(SCHEMA[key].sheet)];if(!ws)continue;found++;const rows=readSheet(XLSX,ws);if(!rows.length)continue;
    const fs=fieldsOf(SCHEMA[key]);const map=rows[0].map(h=>h?fs.find(f=>H.normKey(f.k)===H.normKey(h.v)||H.normKey(f.l)===H.normKey(h.v)):null);
    const out=[];for(const row of rows.slice(1)){if(!row.some(c=>c&&c.v!==''&&c.v!=null))continue;const rec=H.defaults(key);row.forEach((c,i)=>{const f=map[i];if(f&&c)rec[f.k]=H.coerce(f,c.v,c)});out.push(rec)}
    ns[key]=out;report.push(`${SCHEMA[key].title}: ${out.length} rows`)}
  if(!found)throw new Error('No recognised sheets. Use the Excel template sheet names: '+[...SINGLES,...COLS].map(c=>SCHEMA[c].sheet).join(', ')+'.');
  ns.isSample=false;return {ns,report};
}
$('#btnImport').onclick=()=>$('#fileIn').click();
$('#fileIn').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;
  try{if(file.size>10*1024*1024)throw new Error('The file is larger than 10 MB.');let res;
    if(/\.json$/i.test(file.name)){res={ns:H.normalise(JSON.parse(await file.text())),report:['Full household from JSON']};res.ns.isSample=false}
    else{const XLSX=await loadXLSX();const wb=XLSX.read(await file.arrayBuffer(),{cellDates:true,cellNF:true});res=importWorkbook(XLSX,wb)}
    const audit=state.S.audit;setState(res.ns);if(Store.mode==='local'){state.S.audit=audit||[];logChange('import',file.name,res.report.join('; '))}
    Store.touch();state.OPEN.clear();state.OPEN.add('members:0');
    state.banner={cls:'ok',html:`<b>Imported ${esc(file.name)}.</b> ${esc(res.report.join(' · '))}. Check KYC and onboarding status for gaps.`};state.VIEW='members';render();
  }catch(err){state.banner={cls:'bad',html:`<b>Could not import ${esc(file.name)}.</b> ${esc(err.message)}`};render()}};

function outVal(f,v){if(f.t===YN)return yes(v)?'Yes':'No';if(f.t==='sel'){const o=optList(f.o).find(x=>String(x[0])===String(v));return o?o[1]:v}return v??''}
async function buildWorkbook(withData){
  const XLSX=await loadXLSX();const wb=XLSX.utils.book_new();
  const readme=[['Household Wealth Profiler: data template'],['One sheet per data type. Keep the sheet names and the header row. Each row is one record.'],['Link records to people with the Reference code from the Members sheet (P1, P2, C1…). Use JOINT for jointly owned items.'],['Percent columns take numbers such as 2.5 for 2.5%. Yes/No columns take Yes or No. Dates use YYYY-MM-DD.'],[],['Sheet','Column','Type','Allowed values / guidance']];
  for(const key of ['household','mandate','compliance',...COLS,'assumptions'])for(const f of fieldsOf(SCHEMA[key]))readme.push([SCHEMA[key].sheet,f.l,{text:'Text',num:'Number',pct:'Percent',int:'Whole number',date:'Date',sel:'List',bool:'Yes / No',area:'Text',owner:'Person ref or JOINT',member:'Person ref'}[f.t],(f.t==='sel'?optList(f.o).map(o=>o[1]).join(' | '):'')+(f.h?(f.t==='sel'?' — ':'')+f.h:'')]);
  const rws=XLSX.utils.aoa_to_sheet(readme);rws['!cols']=[{wch:16},{wch:40},{wch:18},{wch:90}];XLSX.utils.book_append_sheet(wb,rws,'README');
  for(const key of ['household','mandate','compliance']){const fs=fieldsOf(SCHEMA[key]);const ws=XLSX.utils.aoa_to_sheet([['Field','Value'],...fs.map(f=>[f.l,withData?outVal(f,state.S[key][f.k]):''])]);ws['!cols']=[{wch:44},{wch:50}];XLSX.utils.book_append_sheet(wb,ws,SCHEMA[key].sheet)}
  for(const key of COLS){const fs=fieldsOf(SCHEMA[key]);const aoa=[fs.map(f=>f.l)];if(withData)state.S[key].forEach(r=>aoa.push(fs.map(f=>outVal(f,r[f.k]))));const ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=fs.map(f=>({wch:Math.max(12,Math.min(30,f.l.length+2))}));XLSX.utils.book_append_sheet(wb,ws,SCHEMA[key].sheet)}
  {const fs=fieldsOf(SCHEMA.assumptions);const src=withData?state.S.assumptions:H.defaults('assumptions');const ws=XLSX.utils.aoa_to_sheet([['Field','Value'],...fs.map(f=>[f.l,outVal(f,src[f.k])])]);ws['!cols']=[{wch:40},{wch:14}];XLSX.utils.book_append_sheet(wb,ws,'Assumptions')}
  if(withData){const C=state.E.compute();const gl=Object.fromEntries([...GROUPS_A,...GROUPS_L]);const aoa=[['Side','Group','Line',...C.views.map(v=>v==='HH'?'Household':memberName(v))]];
    for(const l of C.lines)aoa.push([l.side==='A'?'Asset':'Liability',gl[l.group],l.label,...C.views.map(v=>Math.round(C.val(l,v)))]);
    aoa.push([]);aoa.push(['','','Economic net worth',...C.views.map(v=>Math.round(C.tot[v].A-C.tot[v].L))]);
    const ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=[{wch:10},{wch:30},{wch:44},...C.views.map(()=>({wch:14}))];XLSX.utils.book_append_sheet(wb,ws,'EconomicBalanceSheet');
    const O=state.E.onboarding(C);const ob=[['Status',O.stage],['AML risk rating',O.rating],['AML score',O.score],['EDD required',O.edd?'Yes':'No'],['Review every (years)',O.reviewYears],['Next review',O.nextReview||''],[],['Stage','Level','Item']];
    for(const i of O.items)ob.push([i.stage,i.lvl==='bad'?'Blocker':'Review',i.msg]);for(const f of O.factors)ob.push(['AML factor','+'+f.pts,f.why]);
    const ows=XLSX.utils.aoa_to_sheet(ob);ows['!cols']=[{wch:20},{wch:12},{wch:90}];XLSX.utils.book_append_sheet(wb,ows,'OnboardingStatus');
    let au=[];try{au=await Store.audit()}catch(e){}
    const aws=XLSX.utils.aoa_to_sheet([['When','Who','Field','From','To'],...au.map(r=>[r.ts,r.user,r.field,String(r.from??''),String(r.to??'')])]);aws['!cols']=[{wch:22},{wch:18},{wch:34},{wch:30},{wch:30}];XLSX.utils.book_append_sheet(wb,aws,'AuditTrail')}
  return XLSX.write(wb,{type:'array',bookType:'xlsx'});
}
/* Downloads: the Claude artifact viewer needs its downloads capability;
   a normal browser uses a blob link. */
let DL=null;
async function save(filename,data){
  const blob=data instanceof Blob?data:new Blob([data]);
  if(DL){try{await DL.save({filename,data:blob});toast('Saved '+filename)}catch(err){if(err&&err.code!=='declined')toast(err&&err.code==='rate_limited'?'A save is already waiting for your confirmation':'Could not save the file')}return}
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);toast('Downloaded '+filename);
}
const stamp=()=>(state.S.household.reference||state.S.household.name||'household').replace(/[^\w-]+/g,'_');
$('#btnTemplate').onclick=async()=>{try{save('household-data-template.xlsx',new Blob([await buildWorkbook(false)]))}catch(e){toast(e.message)}};
$('#btnExport').onclick=async()=>{try{save(stamp()+'-profile.xlsx',new Blob([await buildWorkbook(true)]))}catch(e){toast(e.message)}};
$('#btnJson').onclick=()=>save(stamp()+'-profile.json',JSON.stringify(state.S,null,2));
$('#btnClients').onclick=async()=>{await Store.flush();state.VIEW='clients';state.banner=null;render()};

/* ---------- start ---------- */
(async()=>{
  try{if(window.claude&&window.claude.use)window.claude.use('downloads').then(d=>{DL=d},()=>{})}catch(e){DL=null}
  try{await Store.init()}catch(e){document.body.classList.add('gated');
    $('#main').innerHTML=`<div class="panel gate"><h2>Cannot open the profiler</h2><p>${esc(e.message)}</p>${Store.cloud?'<div class="addrow"><button class="btn" type="button" data-act="signOut">Sign out</button></div>':''}</div>`;return}
  if(Store.mode==='server'){setState(H.blank());state.VIEW='clients'}
  else{setState(Store.loadLocal()||H.sample())}
  resetUI(false);render();
})();
})();
