/* The connection to the backend and saving, for every screen.
     Store       where the household is kept and how it is saved: on the server (the API, or the
                 Supabase edition through cloud.js) or, with no server, in this browser only.
                 Edits mark the household dirty; it is saved 1.2 s after the last edit. A save that
                 finds someone else's newer version shows the conflict banner and saves nothing; a
                 save the server refuses by code (duplicate_reference, invalid_field) shows what to
                 change and is retried on the next edit.
     saveStatus  the "All changes saved" / "Saving…" / "Not saved…" text in the header
     logChange   the audit trail kept in the browser when there is no server
   Only this module calls the backend. */
import { state, setState } from '../state.js';
import { $, esc } from '../lib/dom.js';

const H = window.HWP;

// Shown instead of the app when it is served by the server but the server does not answer
export const NO_SERVER = 'The server could not be reached, so nothing you enter would be saved. Check your connection, then reload this page.';

// The screen redraw, set by main.js at start-up (this module cannot import from main.js)
let rerender = () => {};
export function setRenderer(fn) { rerender = fn; }

const LS='hwp-draft-v2',LS_USER='hwp-user';

// A refused save's problems, as the server lists them ({ field, message }), described by screen and label: People entry 2, Date of birth: must be a date
function describeProblem(p,firmSettings){const m=/^(\w+)(?:\[(\d+)\])?(?:\.(\w+))?$/.exec(p.field||'');if(!m)return esc(p.field)+': '+esc(p.message);
  const sec=H.SCHEMA[m[1]];const where=(sec?sec.title:m[1])+(m[2]!=null?' entry '+(+m[2]+1):'');const label=m[3]?(sec?H.fieldLabel(m[1],m[3]):m[3]):'';
  return esc(where+(label?', '+label:'')+': '+p.message)}
const problemList=(body,firm)=>'<ul>'+((body&&body.errors)||[]).map(p=>'<li>'+describeProblem(p,firm)+'</li>').join('')+'</ul>';
const CFG=window.HWP_CONFIG||{};
const Store={mode:'local',user:'',id:null,version:0,dirty:false,saving:false,encrypted:false,production:false,cloud:null,role:'',firm:'',seats:0,
  async init(){
    if(CFG.supabaseUrl&&window.HWPCloud){this.cloud=await window.HWPCloud.gate();const j=await this.api('GET','me');
      Object.assign(this,{mode:'server',user:j.user,email:j.email,role:j.role,firmName:j.firm,seats:j.seats,encrypted:!!j.encrypted});return}
    // Only the standalone single file (npm run build) keeps data in this browser: it has no server
    if(window.HWP_STANDALONE===true){this.mode='local';try{this.user=localStorage.getItem(LS_USER)||''}catch(e){this.user=''}return}
    // Served by the server: the server must answer. Never fall back to browser storage, or client
    // details could be entered that are never saved, encrypted or audited on the server.
    let j=null;
    try{const r=await fetch('api/me',{credentials:'same-origin',headers:{'Accept':'application/json'}});
      if(r.ok&&(r.headers.get('content-type')||'').includes('json'))j=await r.json()}catch(e){}
    if(j&&j.user){this.mode='server';this.user=j.user;this.encrypted=!!j.encrypted;this.production=!!j.production;return}
    throw new Error(NO_SERVER);
  },
  loadLocal(){try{const r=localStorage.getItem(LS);return r?window.HWP.normalise(JSON.parse(r)):null}catch(e){return null}},
  saveLocal(){try{localStorage.setItem(LS,JSON.stringify(state.S))}catch(e){}},
  async api(method,path,body,extraHeaders){const headers={'Accept':'application/json',...(extraHeaders||{})};if(body)headers['Content-Type']='application/json';
    if(this.cloud){headers.Authorization='Bearer '+await this.cloud.token();headers.apikey=CFG.supabaseKey}
    const r=await fetch(this.cloud?CFG.supabaseUrl.replace(/\/+$/,'')+'/functions/v1/api/'+path:'api/'+path,{method,credentials:this.cloud?'omit':'same-origin',headers,body:body?JSON.stringify(body):undefined});
    let j=null;try{j=await r.json()}catch(e){}
    if(this.cloud&&(r.status===401||(j&&j.code==='mfa_required'))){location.reload();return new Promise(()=>{})}
    if(!r.ok){const err=new Error((j&&j.error)||('Request failed ('+r.status+')'));err.status=r.status;err.body=j;throw err}return j},
  async list(){return this.api('GET','households')},
  firm:{version:0,settings:null,dirty:false,saving:false,err:null},
  // Served by a server: the firm settings come from it or the app does not open (never from this browser)
  async loadFirm(){if(this.mode==='server'){let j;try{j=await this.api('GET','firm')}catch(e){throw new Error('The firm settings could not be loaded from the server, so nothing you enter would be saved correctly. Check your connection, then reload this page.')}
      this.firm.version=j.version;this.firm.settings=H.firmNormalise(j.settings);return}
    // The standalone demo file only
    let x=null;try{x=JSON.parse(localStorage.getItem('hwp-firm')||'null')}catch(e){}this.firm.settings=H.firmNormalise(x)},
  touchFirm(){if(this.mode!=='server'){try{localStorage.setItem('hwp-firm',JSON.stringify(this.firm.settings))}catch(e){}return}
    this.firm.dirty=true;saveStatus();clearTimeout(this.ft);this.ft=setTimeout(()=>this.flushFirm(),1000)},
  async flushFirm(){const F=this.firm;if(this.mode!=='server'||!F.dirty||F.saving)return;F.saving=true;F.dirty=false;
    try{const j=await this.api('PUT','firm',{version:F.version,settings:F.settings});F.version=j.version;if(F.err==='invalid'){state.banner=null;rerender()}F.err=null}
    catch(e){const code=e.body&&e.body.code;F.err=code==='invalid_field'?'invalid':e.status===409?'conflict':e.status===403?'forbidden':'failed';if(F.err==='failed'||F.err==='invalid')F.dirty=true;
      state.banner={cls:'bad',sticky:F.err==='conflict'||F.err==='forbidden',html:F.err==='conflict'?'<b>Someone else changed the firm settings.</b> Your latest change was not saved. <button class="btn" type="button" data-act="reloadFirm">Reload</button>':F.err==='forbidden'?'Only a firm administrator can change firm settings.':F.err==='invalid'?'<b>Firm settings not saved: some values are outside the rules.</b> Correct them and they will be saved.'+problemList(e.body,true):'Firm settings not saved. Retrying when you edit.'};rerender()}
    finally{F.saving=false;saveStatus()}},
  async open(id){const j=await this.api('GET','households/'+encodeURIComponent(id));this.id=j.id;this.version=j.version;setState(window.HWP.normalise(j.state));this.dirty=false;return j},
  // Each create carries a fresh key, so a double-click or a retried request cannot make a second household
  async create(household){const key=crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2);
    const j=await this.api('POST','households',{state:household},{'Idempotency-Key':key});this.id=j.id;this.version=j.version;return j},
  async audit(){return this.mode==='server'&&this.id?this.api('GET','households/'+encodeURIComponent(this.id)+'/audit'):(state.S.audit||[]).slice().reverse()},
  touch(){if(this.mode==='local'){clearTimeout(this.t);this.t=setTimeout(()=>this.saveLocal(),300);return}
    if(!this.id)return;this.dirty=true;saveStatus();clearTimeout(this.t);this.t=setTimeout(()=>this.flush(),1200)},
  async flush(){if(this.mode!=='server'||!this.id||!this.dirty||this.saving)return;this.saving=true;this.dirty=false;saveStatus();
    try{const j=await this.api('PUT','households/'+encodeURIComponent(this.id),{version:this.version,state:state.S});this.version=j.version;if(this.err==='invalid'||this.err==='duplicate'){state.banner=null;rerender()}this.err=null}
    catch(e){const code=e.body&&e.body.code;
      if(code==='duplicate_reference'){this.err='duplicate';this.dirty=true;state.banner={cls:'bad',html:'<b>Not saved: another household in this firm already uses this client reference.</b> Change the reference and it will be saved.'};rerender()}
      else if(code==='invalid_field'){this.err='invalid';this.dirty=true;state.banner={cls:'bad',html:'<b>Not saved: some values are outside the rules.</b> Correct them and the household will be saved.'+problemList(e.body)};rerender()}
      else if(e.status===409){this.err='conflict';state.banner={cls:'bad',sticky:true,html:'<b>Someone else saved this household since you opened it.</b> Your latest changes were not saved. <button class="btn" type="button" data-act="reloadHousehold">Reload their version</button>'};rerender()}
      else{this.err='failed';this.dirty=true}}
    finally{this.saving=false;saveStatus();if(this.dirty&&!this.err)this.touch()}}
};
function saveStatus(){const el=$('#saveState');if(!el)return;
  if(Store.mode!=='server'){el.textContent='Saved in this browser only';el.className='save';return}
  if(!Store.id){el.textContent='';return}
  el.className='save'+(Store.err?' err':'');
  el.textContent=Store.err==='conflict'?'Not saved: newer version exists':Store.err==='duplicate'?'Not saved: client reference already in use':Store.err==='invalid'?'Not saved: see the message above':Store.err?'Not saved. Retrying when you edit':Store.saving?'Saving…':Store.dirty?'Unsaved changes':'All changes saved';}
window.addEventListener('beforeunload',e=>{if(Store.mode==='server'&&(Store.dirty||Store.saving)){e.preventDefault();e.returnValue=''}});

/* Local audit trail (server mode records it on the server instead) */
function logChange(path,from,to){if(Store.mode!=='local')return;state.S.audit=state.S.audit||[];const now=Date.now();const last=state.S.audit[state.S.audit.length-1];
  if(last&&last.field===path&&last.user===Store.user&&now-new Date(last.ts).getTime()<15000){last.to=to;last.ts=new Date(now).toISOString();return}
  state.S.audit.push({ts:new Date(now).toISOString(),user:Store.user||'Unnamed user',field:path,from:from??'',to:to??''});if(state.S.audit.length>2000)state.S.audit.shift()}

export { Store, saveStatus, logChange, LS_USER, CFG };
