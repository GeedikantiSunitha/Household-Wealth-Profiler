/* The connection to the backend and saving, for every screen.
     Store       where the household is kept and how it is saved: on the server (the API, or the
                 Supabase edition through cloud.js) or, with no server, in this browser only.
                 Edits mark the household dirty; it is saved 1.2 s after the last edit. A save that
                 finds someone else's newer version shows the conflict banner and saves nothing.
     saveStatus  the "All changes saved" / "Saving…" / "Not saved…" text in the header
     logChange   the audit trail kept in the browser when there is no server
   Only this module calls the backend. */
import { state, setState } from '../state.js';
import { $ } from '../lib/dom.js';

// The screen redraw, set by main.js at start-up (this module cannot import from main.js)
let rerender = () => {};
export function setRenderer(fn) { rerender = fn; }

const LS='hwp-draft-v2',LS_USER='hwp-user';
const CFG=window.HWP_CONFIG||{};
const Store={mode:'local',user:'',id:null,version:0,dirty:false,saving:false,encrypted:false,cloud:null,role:'',firm:'',seats:0,
  async init(){
    if(CFG.supabaseUrl&&window.HWPCloud){this.cloud=await window.HWPCloud.gate();const j=await this.api('GET','me');
      Object.assign(this,{mode:'server',user:j.user,email:j.email,role:j.role,firm:j.firm,seats:j.seats,encrypted:!!j.encrypted});return}
    try{const r=await fetch('api/me',{credentials:'same-origin',headers:{'Accept':'application/json'}});
      if(r.ok&&(r.headers.get('content-type')||'').includes('json')){const j=await r.json();if(j&&j.user){this.mode='server';this.user=j.user;this.encrypted=!!j.encrypted;return}}}catch(e){}
    this.mode='local';try{this.user=localStorage.getItem(LS_USER)||''}catch(e){this.user=''}
  },
  loadLocal(){try{const r=localStorage.getItem(LS);return r?window.HWP.normalise(JSON.parse(r)):null}catch(e){return null}},
  saveLocal(){try{localStorage.setItem(LS,JSON.stringify(state.S))}catch(e){}},
  async api(method,path,body){const headers={'Accept':'application/json'};if(body)headers['Content-Type']='application/json';
    if(this.cloud){headers.Authorization='Bearer '+await this.cloud.token();headers.apikey=CFG.supabaseKey}
    const r=await fetch(this.cloud?CFG.supabaseUrl.replace(/\/+$/,'')+'/functions/v1/api/'+path:'api/'+path,{method,credentials:this.cloud?'omit':'same-origin',headers,body:body?JSON.stringify(body):undefined});
    let j=null;try{j=await r.json()}catch(e){}
    if(this.cloud&&(r.status===401||(j&&j.code==='mfa_required'))){location.reload();return new Promise(()=>{})}
    if(!r.ok){const err=new Error((j&&j.error)||('Request failed ('+r.status+')'));err.status=r.status;err.body=j;throw err}return j},
  async list(){return this.api('GET','households')},
  async open(id){const j=await this.api('GET','households/'+encodeURIComponent(id));this.id=j.id;this.version=j.version;setState(window.HWP.normalise(j.state));this.dirty=false;return j},
  async create(household){const j=await this.api('POST','households',{state:household});this.id=j.id;this.version=j.version;return j},
  async audit(){return this.mode==='server'&&this.id?this.api('GET','households/'+encodeURIComponent(this.id)+'/audit'):(state.S.audit||[]).slice().reverse()},
  touch(){if(this.mode==='local'){clearTimeout(this.t);this.t=setTimeout(()=>this.saveLocal(),300);return}
    if(!this.id)return;this.dirty=true;saveStatus();clearTimeout(this.t);this.t=setTimeout(()=>this.flush(),1200)},
  async flush(){if(this.mode!=='server'||!this.id||!this.dirty||this.saving)return;this.saving=true;this.dirty=false;saveStatus();
    try{const j=await this.api('PUT','households/'+encodeURIComponent(this.id),{version:this.version,state:state.S});this.version=j.version;this.err=null}
    catch(e){if(e.status===409){this.err='conflict';state.banner={cls:'bad',sticky:true,html:'<b>Someone else saved this household since you opened it.</b> Your latest changes were not saved. <button class="btn" type="button" data-act="reloadHousehold">Reload their version</button>'};rerender()}
      else{this.err='failed';this.dirty=true}}
    finally{this.saving=false;saveStatus();if(this.dirty&&!this.err)this.touch()}}
};
function saveStatus(){const el=$('#saveState');if(!el)return;
  if(Store.mode!=='server'){el.textContent='Saved in this browser only';el.className='save';return}
  if(!Store.id){el.textContent='';return}
  el.className='save'+(Store.err?' err':'');
  el.textContent=Store.err==='conflict'?'Not saved: newer version exists':Store.err?'Not saved. Retrying when you edit':Store.saving?'Saving…':Store.dirty?'Unsaved changes':'All changes saved';}
window.addEventListener('beforeunload',e=>{if(Store.mode==='server'&&(Store.dirty||Store.saving)){e.preventDefault();e.returnValue=''}});

/* Local audit trail (server mode records it on the server instead) */
function logChange(path,from,to){if(Store.mode!=='local')return;state.S.audit=state.S.audit||[];const now=Date.now();const last=state.S.audit[state.S.audit.length-1];
  if(last&&last.field===path&&last.user===Store.user&&now-new Date(last.ts).getTime()<15000){last.to=to;last.ts=new Date(now).toISOString();return}
  state.S.audit.push({ts:new Date(now).toISOString(),user:Store.user||'Unnamed user',field:path,from:from??'',to:to??''});if(state.S.audit.length>2000)state.S.audit.shift()}

export { Store, saveStatus, logChange, LS_USER, CFG };
