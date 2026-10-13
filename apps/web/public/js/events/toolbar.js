/* Top-bar buttons: Import Excel / JSON, Excel template, Export Excel, Export JSON, All households. Wired when this module loads (main.js imports it for that). */
import { Store, logChange } from '../api/store.js';
import { save } from '../io/download.js';
import { buildWorkbook, importWorkbook, loadXLSX } from '../io/excel.js';
import { describeUnknown, unknownDropdowns } from '../io/import-check.js';
import { $, esc, toast } from '../lib/dom.js';
import { setState, state } from '../state.js';
import { render } from '../views/render.js';

const H = window.HWP;

export const stamp=()=>(state.S.household.reference||state.S.household.name||'household').replace(/[^\w-]+/g,'_');
$('#btnImport').onclick=()=>$('#fileIn').click();
$('#fileIn').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;
  try{if(file.size>10*1024*1024)throw new Error('The file is larger than 10 MB.');let res;
    if(/\.json$/i.test(file.name)){res={ns:H.normalise(JSON.parse(await file.text())),report:['Full household from JSON']};res.ns.isSample=false}
    else{const XLSX=await loadXLSX();const wb=XLSX.read(await file.arrayBuffer(),{cellDates:true,cellNF:true});res=importWorkbook(XLSX,wb)}
    // Every dropdown value the form does not offer is listed first (the server would refuse the save), so the file can be fixed in one pass
    const unknown=unknownDropdowns(H,res.ns);
    if(unknown.length){state.banner={cls:'bad',html:`<b>Not imported: ${unknown.length} dropdown value${unknown.length===1?'':'s'} in ${esc(file.name)} ${unknown.length===1?'is':'are'} not among the options.</b> Correct ${unknown.length===1?'it':'them'} in the file and import again:<ul>${unknown.map(u=>'<li>'+esc(describeUnknown(u))+'</li>').join('')}</ul>`};render();return}
    const audit=state.S.audit;setState(res.ns);if(Store.mode==='local'){state.S.audit=audit||[];logChange('import',file.name,res.report.join('; '))}
    Store.touch();state.OPEN.clear();state.OPEN.add('members:0');
    state.banner={cls:'ok',html:`<b>Imported ${esc(file.name)}.</b> ${esc(res.report.join(' · '))}. Check KYC and onboarding status for gaps.`};state.VIEW='members';render();
  }catch(err){state.banner={cls:'bad',html:`<b>Could not import ${esc(file.name)}.</b> ${esc(err.message)}`};render()}};
$('#btnTemplate').onclick=async()=>{try{save('household-data-template.xlsx',new Blob([await buildWorkbook(false)]))}catch(e){toast(e.message)}};
$('#btnExport').onclick=async()=>{try{save(stamp()+'-profile.xlsx',new Blob([await buildWorkbook(true)]))}catch(e){toast(e.message)}};
$('#btnJson').onclick=()=>save(stamp()+'-profile.json',JSON.stringify(state.S,null,2));
$('#btnClients').onclick=async()=>{await Store.flush();state.VIEW='clients';state.banner=null;render()};
