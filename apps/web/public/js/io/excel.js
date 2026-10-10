/* Excel workbooks: the import reader (one sheet per data type, matched by sheet name and column title) and the template / export builder. SheetJS is loaded only when a workbook is needed: the self-hosted copy first (scripts/fetch-xlsx.sh), else cdnjs. */
import { Store } from '../api/store.js';
import { memberName } from '../lib/people.js';
import { state } from '../state.js';
import { GROUPS_A, GROUPS_L } from '../views/balance-sheet.js';

const H = window.HWP; const { SCHEMA, COLS, SINGLES, YN, fieldsOf, optList, yes } = H;

export let xlsxP=null;
export function loadXLSX(){if(window.XLSX)return Promise.resolve(window.XLSX);if(xlsxP)return xlsxP;
  const tryLoad=src=>new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=()=>window.XLSX?res(window.XLSX):rej();s.onerror=rej;document.head.appendChild(s)});
  xlsxP=tryLoad('vendor/xlsx.full.min.js').catch(()=>tryLoad('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js')).catch(()=>{xlsxP=null;throw new Error('The spreadsheet reader could not be loaded. Check your connection and try again.')});
  return xlsxP}
export function readSheet(XLSX,ws){const rows=[];if(!ws||!ws['!ref'])return rows;const R=XLSX.utils.decode_range(ws['!ref']);
  for(let r=R.s.r;r<=Math.min(R.e.r,R.s.r+5000);r++){const row=[];for(let c=R.s.c;c<=Math.min(R.e.c,R.s.c+80);c++){const cell=ws[XLSX.utils.encode_cell({r,c})];row.push(cell?{v:cell.v,z:cell.z}:null)}rows.push(row)}return rows}
export function importWorkbook(XLSX,wb){
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
export function outVal(f,v){if(f.t===YN)return yes(v)?'Yes':'No';if(f.t==='sel'){const o=optList(f.o).find(x=>String(x[0])===String(v));return o?o[1]:v}return v??''}
export async function buildWorkbook(withData){
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
