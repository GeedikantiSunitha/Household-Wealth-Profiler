/* Household Wealth Profiler: user interface.
   Uses window.HWP (core.js) for every calculation.
   Runs in two modes:
   - server: talks to server.js (logins, encrypted storage, versions, audit trail)
   - cloud:  the Supabase edition (config.js sets supabaseUrl); same as server mode, but signs in
             through cloud.js and calls the `api` Edge Function with a bearer token
   - local:  no server found; drafts stay in this browser only */
(function(){
'use strict';
const H=window.HWP;
const {SCHEMA,COLS,SINGLES,YN,ROLES,WGROUP,EXP_CATS,ASSET_CLASSES,ROLLUP,fieldsOf,optList,N,has,yes}=H;

/* ---------- state ---------- */
let S,E;
function setState(ns){S=ns;E=H.bind(S)}
let VIEW='household',BSVIEW='HH';
const OPEN=new Set(['members:0','income:0','accounts:0']);
let banner=null;

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const gbp=(n,dp=0)=>{if(!isFinite(n))return '–';const s=Math.abs(n).toLocaleString('en-GB',{maximumFractionDigits:dp,minimumFractionDigits:dp});return (n<0?'−£':'£')+s};
const gbpK=n=>{if(!isFinite(n))return '–';const a=Math.abs(n);const s=a>=1e6?(a/1e6).toFixed(2)+'m':a>=1e4?Math.round(a/1e3)+'k':Math.round(a).toLocaleString('en-GB');return (n<0?'−£':'£')+s};
const pct=(n,dp=0)=>isFinite(n)?(n*100).toFixed(dp)+'%':'–';
const fmtDate=s=>{const d=H.parseDate(s);return d?d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'–'};
const fmtTs=s=>{const d=new Date(s);return isNaN(d)?s:d.toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})};
function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,2800)}
const memberName=r=>E.memberName(r);
const isAdult=m=>E.isAdult(m);

/* ---------- storage: server or this browser ---------- */
const LS='hwp-draft-v2',LS_USER='hwp-user';
const CFG=window.HWP_CONFIG||{};
const Store={mode:'local',user:'',id:null,version:0,dirty:false,saving:false,encrypted:false,cloud:null,role:'',firm:'',seats:0,
  async init(){
    if(CFG.supabaseUrl&&window.HWPCloud){this.cloud=await window.HWPCloud.gate();const j=await this.api('GET','me');
      Object.assign(this,{mode:'server',user:j.user,email:j.email,role:j.role,firmName:j.firm,seats:j.seats,encrypted:!!j.encrypted});return}
    try{const r=await fetch('api/me',{credentials:'same-origin',headers:{'Accept':'application/json'}});
      if(r.ok&&(r.headers.get('content-type')||'').includes('json')){const j=await r.json();if(j&&j.user){this.mode='server';this.user=j.user;this.encrypted=!!j.encrypted;return}}}catch(e){}
    this.mode='local';try{this.user=localStorage.getItem(LS_USER)||''}catch(e){this.user=''}
  },
  loadLocal(){try{const r=localStorage.getItem(LS);return r?H.normalise(JSON.parse(r)):null}catch(e){return null}},
  saveLocal(){try{localStorage.setItem(LS,JSON.stringify(S))}catch(e){}},
  async api(method,path,body){const headers={'Accept':'application/json'};if(body)headers['Content-Type']='application/json';
    if(this.cloud){headers.Authorization='Bearer '+await this.cloud.token();headers.apikey=CFG.supabaseKey}
    const r=await fetch(this.cloud?CFG.supabaseUrl.replace(/\/+$/,'')+'/functions/v1/api/'+path:'api/'+path,{method,credentials:this.cloud?'omit':'same-origin',headers,body:body?JSON.stringify(body):undefined});
    let j=null;try{j=await r.json()}catch(e){}
    if(this.cloud&&(r.status===401||(j&&j.code==='mfa_required'))){location.reload();return new Promise(()=>{})}
    if(!r.ok){const err=new Error((j&&j.error)||('Request failed ('+r.status+')'));err.status=r.status;err.body=j;throw err}return j},
  async list(){return this.api('GET','households')},
  firm:{version:0,settings:null,dirty:false,saving:false,err:null},
  async loadFirm(){if(this.mode==='server'){try{const j=await this.api('GET','firm');this.firm.version=j.version;this.firm.settings=H.firmNormalise(j.settings);return}catch(e){}}
    let x=null;try{x=JSON.parse(localStorage.getItem('hwp-firm')||'null')}catch(e){}this.firm.settings=H.firmNormalise(x)},
  touchFirm(){if(this.mode!=='server'){try{localStorage.setItem('hwp-firm',JSON.stringify(this.firm.settings))}catch(e){}return}
    this.firm.dirty=true;saveStatus();clearTimeout(this.ft);this.ft=setTimeout(()=>this.flushFirm(),1000)},
  async flushFirm(){const F=this.firm;if(this.mode!=='server'||!F.dirty||F.saving)return;F.saving=true;F.dirty=false;
    try{const j=await this.api('PUT','firm',{version:F.version,settings:F.settings});F.version=j.version;F.err=null}
    catch(e){F.err=e.status===409?'conflict':e.status===403?'forbidden':'failed';if(F.err==='failed')F.dirty=true;
      banner={cls:'bad',sticky:F.err!=='failed',html:F.err==='conflict'?'<b>Someone else changed the firm settings.</b> Your latest change was not saved. <button class="btn" type="button" data-act="reloadFirm">Reload</button>':F.err==='forbidden'?'Only a firm administrator can change firm settings.':'Firm settings not saved. Retrying when you edit.'};render()}
    finally{F.saving=false;saveStatus()}},
  async open(id){const j=await this.api('GET','households/'+encodeURIComponent(id));this.id=j.id;this.version=j.version;setState(H.normalise(j.state));this.dirty=false;return j},
  async create(state){const j=await this.api('POST','households',{state});this.id=j.id;this.version=j.version;return j},
  async audit(){return this.mode==='server'&&this.id?this.api('GET','households/'+encodeURIComponent(this.id)+'/audit'):(S.audit||[]).slice().reverse()},
  touch(){if(this.mode==='local'){clearTimeout(this.t);this.t=setTimeout(()=>this.saveLocal(),300);return}
    if(!this.id)return;this.dirty=true;saveStatus();clearTimeout(this.t);this.t=setTimeout(()=>this.flush(),1200)},
  async flush(){if(this.mode!=='server'||!this.id||!this.dirty||this.saving)return;this.saving=true;this.dirty=false;saveStatus();
    try{const j=await this.api('PUT','households/'+encodeURIComponent(this.id),{version:this.version,state:S});this.version=j.version;this.err=null}
    catch(e){if(e.status===409){this.err='conflict';banner={cls:'bad',sticky:true,html:'<b>Someone else saved this household since you opened it.</b> Your latest changes were not saved. <button class="btn" type="button" data-act="reloadHousehold">Reload their version</button>'};render()}
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
function logChange(path,from,to){if(Store.mode!=='local')return;S.audit=S.audit||[];const now=Date.now();const last=S.audit[S.audit.length-1];
  if(last&&last.field===path&&last.user===Store.user&&now-new Date(last.ts).getTime()<15000){last.to=to;last.ts=new Date(now).toISOString();return}
  S.audit.push({ts:new Date(now).toISOString(),user:Store.user||'Unnamed user',field:path,from:from??'',to:to??''});if(S.audit.length>2000)S.audit.shift()}

/* ---------- navigation ---------- */
const NAV=[
  ['client','Client',[['household'],['members'],['income'],['expenses'],['goals'],['assumptions']]],
  ['wealth','Wealth',[['accounts'],['db'],['property'],['other'],['liabilities'],['protection']]],
  ['onboarding','Onboarding',[['compliance'],['rtq','Risk questionnaire'],['kyc','KYC status'],['audit','Audit trail']]],
  ['relationship','Relationship',[['contacts'],['actions'],['loas','Letters of authority'],['complaints'],['reviews','Reviews due']]],
  ['mandate','Mandate',[['mandate'],['models','Model portfolios'],['drift','Mandate check']]],
  ['analysis','Analysis',[['bs','Balance sheet'],['tax','Tax and allowances'],['risk','Risk profile and IPS'],['checks','Data checks'],['guide','How the model works']]]];
const NAV_OPEN=new Set();
const FIRM_VIEWS=new Set(['clients','team','diary','tasks','firmSettings']);
function renderNav(){
  if(FIRM_VIEWS.has(VIEW)){const fn=(Store.firm.settings&&Store.firm.settings.firm.name)||(typeof Store.firm==='string'?Store.firm:'')||'Firm';
    $('#rail').innerHTML=`<div class="ng open here"><div class="ng-h" style="cursor:default"><span class="ng-t">${esc(Store.firmName||fn)}</span></div><div class="ng-b">
      <button type="button" data-act="goClients" aria-current="${VIEW==='clients'}"><span>All households</span></button>
      <button type="button" data-act="tasks" aria-current="${VIEW==='tasks'}" title="Every open task across all households, by person"><span>Tasks</span></button>
      <button type="button" data-act="diary" aria-current="${VIEW==='diary'}" title="Every review, expiry, task and complaint deadline across all households"><span>Reviews due</span></button>
      <button type="button" data-act="firmSettings" aria-current="${VIEW==='firmSettings'}" title="Firm details, team members and providers"><span>Firm settings</span></button>
      ${Store.role==='admin'?`<button type="button" data-act="team" aria-current="${VIEW==='team'}" title="Sign-in accounts"><span>User accounts</span></button>`:''}</div></div>`;
    $('#hhName').textContent={team:'User accounts',diary:'Reviews due across the firm',tasks:'Tasks across the firm',firmSettings:'Firm settings'}[VIEW]||'Choose a household to open';return}
  const O=E.onboarding();const bad=E.checks().filter(x=>x.lvl==='bad').length;
  const badge=id=>{const s=SCHEMA[id];let ct='',cls='';if(s&&!s.single)ct=S[id].length||'';
    if(id==='checks'&&bad){ct=bad+' to fix';cls='bad'}
    if(id==='kyc'){ct=O.blockerCount?O.blockerCount+' open':O.stage;cls=O.blockerCount?'bad':''}
    if(id==='reviews'){const R=E.reviews(O);ct=R.overdue?R.overdue+' overdue':R.soon?R.soon+' due soon':'';cls=R.overdue?'bad':''}
    if(id==='actions'){const n=S.actions.filter(H.taskOpen).length;ct=n?n+' open':''}
    if(id==='rtq'){const ad=S.members.filter(isAdult);const done=ad.filter(m=>{const q=S.rtq.find(x=>x.owner===m.ref);return q&&H.rtqScore(q).complete}).length;ct=ad.length?done+'/'+ad.length:'';cls=done<ad.length?'warn':''}
    if(id==='drift'){const MC=E.mandateCheck();ct=MC.status;cls=MC.status==='Incomplete'?'bad':MC.status==='Drift'?'warn':''}
    return {ct,cls}};
  let h='';
  for(const [gid,gl,items] of NAV){const here=items.some(([id])=>id===VIEW);const open=here||NAV_OPEN.has(gid);
    const bs=items.map(([id])=>badge(id));const alerts=bs.filter(b=>b.cls==='bad').length;const warns=bs.filter(b=>b.cls==='warn').length;
    const gb=alerts?`<span class="ct bad">${alerts} alert${alerts>1?'s':''}</span>`:warns?`<span class="ct warn">review</span>`:'';
    h+=`<div class="ng${open?' open':''}${here?' here':''}"><button type="button" class="ng-h" data-act="navGroup" data-g="${gid}" aria-expanded="${open}"><span class="ng-chev">▸</span><span class="ng-t">${gl}</span>${open?'':gb}</button>`;
    if(open)h+=`<div class="ng-b">${items.map(([id,lbl],i)=>{const s=SCHEMA[id];const name=lbl||s.title;const b=bs[i];
      return `<button type="button" data-nav="${id}" aria-current="${VIEW===id}" title="${esc(NAV_HELP[id]||'')}"><span>${esc(name)}</span><span class="ct ${b.cls}">${esc(b.ct)}</span></button>`}).join('')}</div>`;
    h+=`</div>`}
  if(Store.mode!=='server')h+=`<div class="ng"><button type="button" class="ng-h" data-act="firmSettings"><span class="ng-t">Firm settings</span></button></div>`;
  $('#rail').innerHTML=h;
  $('#hhName').textContent=(S.household.name||'Unnamed household')+(S.household.reference?' · '+S.household.reference:'')+' · '+O.stage;
}

/* ---------- help text ----------
   Tooltips for every field, group and section so an analyst can see how each input is used.
   Schema hints (core.js) are used where they exist; FIELD_HELP fills the rest. */
const FIELD_HELP={
  'household.name':'Label for the file and the client list, e.g. "Harrington household".',
  'household.reference':"The firm's own client reference. Recorded only.",
  'household.adviser':'The adviser responsible for the relationship. Recorded for the file and sign-off.',
  'household.valuationDate':'Ages, document expiry checks and screening ages are measured from this date. Defaults to today.',
  'household.willsInPlace':'No wills: flagged in Data checks because intestacy rules would apply. Does not change the figures.',
  'household.lpaInPlace':'Recorded for the planning file. A missing LPA is a planning point, not a calculation input.',
  'household.trusts':'Recorded here; structures that affect AML risk are captured under Onboarding and compliance.',
  'household.objectives':'Captured verbatim for the suitability report and the investment policy statement.',
  'members.title':'Recorded only.','members.firstName':'Used in names throughout the file.','members.lastName':'Used in names throughout the file.',
  'members.role':'Primary and partner are adults: they carry income, KYC and suitability. Children and dependants carry only ages and child wrappers.',
  'members.dob':'Sets age, State Pension age, years to retirement and the survival curve that weights every future cash flow.',
  'members.sex':'Selects the modal age at death used in the mortality model (see Assumptions).',
  'members.smoker':'Smokers: modal age at death reduced by 6 years, lowering human capital and the value of future spending.',
  'members.nationality':'Recorded for CDD. Non-UK nationality with non-UK tax residence triggers the CRS checks.',
  'members.otherNationality':'Recorded for CDD and FATCA (US) screening.',
  'members.countryOfBirth':'Standard customer due diligence data point.',
  'members.address':'Residential address must be verified by the proof of address below.',
  'members.postcode':'Format is checked against the UK postcode pattern.',
  'members.prevAddress':'Record if at the current address for under 3 years.',
  'members.email':'Format is checked. Recorded for contact.','members.phone':'Recorded for contact.',
  'members.idType':'Photo ID is required for every adult. Missing ID is a KYC blocker.',
  'members.idNumber':'Document number as it appears on the ID.',
  'members.idExpiry':'An expired document is a KYC blocker.',
  'members.idMethod':'In person, certified copy or electronic verification. "Not met face to face" also adds an AML point under Onboarding.',
  'members.idCheckedDate':'When the document was seen or verified.',
  'members.poaType':'Proof of address is required and must be dated within 3 months of the valuation date.',
  'members.pep':'Any politically exposed person makes the AML rating High: EDD, verified source of wealth and senior approval are required.',
  'members.pepDetail':'The public function, country and any family or close-associate link.',
  'members.sanctions':'A confirmed match prohibits onboarding. Screening must be dated within 3 months.',
  'members.adverseMedia':'A confirmed finding adds AML points and needs EDD findings recorded.',
  'members.sow':'Source of wealth: how the overall wealth was built. Required for every adult; must be verified when the rating is High.',
  'members.sowEvidence':'What was seen: payslips, accounts, sale completion statement, probate.',
  'members.tins':'Tax identification numbers for each non-UK tax residence. Missing TIN with non-UK residence is a blocker.',
  'members.crsSelfCert':'The CRS/FATCA self-certification is required before onboarding completes.',
  'members.employment':'Employed, self-employed, retired and so on. Students and retired people carry no human capital.',
  'members.occupation':'Recorded for CDD and source-of-wealth plausibility.',
  'members.sector':'Recorded for CDD. Higher-risk sectors should be reflected in the adviser’s risk assessment.',
  'members.retireAge':'Earnings are valued up to this age (65 if blank). Later retirement adds human capital.',
  'members.residence':'UK, non-UK or split. Non-UK residence requires tax IDs and the CRS self-certification.',
  'members.scottish':'Scottish income tax bands are not modelled; this flags that the Tax view is indicative only for this person.',
  'members.usPerson':'US persons bring FATCA reporting. Recorded and flagged for the file.',
  'members.niYears':'Qualifying years for the new State Pension: 35 for the full amount, pro rata from 10.',
  'members.retTaxRate':'Marginal rate assumed on pension withdrawals, used for the deferred tax on pension pots.',
  'members.riskTol':'Willingness to take risk, 1 (lowest) to 7, from the firm’s questionnaire. Adjusted by the loss reaction below.',
  'members.lossReaction':'Sell all: −2 points; sell some: −1; hold: 0; buy more: +1 on the risk tolerance score.',
  'members.experience':'Knowledge and experience, required for suitability (COBS 9A). Does not change the figures.',
  'members.capacity':'Adviser’s view of capacity for loss. Low: −1, high: +1 on the ability-to-take-risk score.',
  'members.esg':'Sustainability preference, recorded for the IPS.',
  'members.vulnerability':'FCA drivers: health, life events, resilience, capability. Recording one requires support needs; health also requires explicit consent.',
  'income.owner':'Who earns or receives it. Earnings use that person’s age, retirement age and survival curve.',
  'income.type':'Employment, bonus, self-employment and dividends are earnings (human capital). Pensions in payment, annuities and benefits are income rights.',
  'income.label':'Employer or source. Recorded only.',
  'income.amount':'Gross amount per year in today’s money.',
  'income.growth':'Real growth per year on top of inflation, compounding over the stream. Blank = 0.',
  'expenses.label':'Description. Recorded only.',
  'expenses.cat':'Essential spending counts in the core funded ratio and cash cover. Discretionary, aspirational, education and care count in the full funded ratio only.',
  'expenses.amount':'Per year in today’s money.',
  'expenses.inflation':'Own inflation rate for the line (school fees, care). Blank uses CPI from Assumptions.',
  'expenses.startIn':'Years until the spending starts. Lines starting later than 0 are excluded from today’s essential outgoings.',
  'goals.label':'Description. Recorded only.',
  'goals.amount':'One-off amount in today’s money, inflated to the due date and discounted back at the gilt rate.',
  'goals.inYears':'Years until the money is needed. Sooner goals are discounted less and weigh more.',
  'goals.priority':'Need, want or wish. Recorded for the IPS; does not change the figures.',
  'accounts.owner':'Owner for tax and allowance checks. Joint splits equally between the adults.',
  'accounts.wrapper':'Sets the tax treatment: pensions carry deferred income tax, taxable accounts carry deferred CGT, ISAs carry none. Also drives allowance checks.',
  'accounts.provider':'Recorded only.',
  'accounts.value':'Current value. Adds to financial assets.',
  'accounts.employerContrib':'Counts towards the pension annual allowance check together with your own contributions.',
  'accounts.reliefMethod':'Relief at source or net pay: changes how contributions are grossed up in the Tax view.',
  'accounts.eq':'Share in equities. Drives the equity exposure compared with risk tolerance.',
  'accounts.bd':'Share in bonds.','accounts.cs':'Share in cash. Cash and easy-access accounts count towards months of cover.',
  'accounts.al':'Share in alternatives (private equity, property funds, hedge funds). Treated as equity-like.',
  'accounts.fee':'Total ongoing cost, recorded for the costs disclosure. Does not change the figures.',
  'accounts.liquidity':'Instant, notice or locked. Locked accounts are excluded from cash cover.',
  'db.owner':'The scheme member. The pension runs on their survival curve.',
  'db.scheme':'Scheme name. Recorded only.',
  'db.status':'Active, deferred or in payment. Pensions already in payment should be recorded under Income.',
  'db.accrued':'Pension per year earned to date, in today’s money.',
  'db.nra':'Age the pension starts. Payments before this age are not valued.',
  'db.indexation':'Increase per year applied to the pension in payment and in deferment.',
  'db.spousePct':'Survivor’s pension as a share of the member’s. Valued for married couples and civil partners.',
  'db.cetv':'Cash equivalent transfer value, shown for comparison only. The balance sheet uses the economic value.',
  'property.owner':'Owner for IHT and CGT. Joint splits equally.',
  'property.type':'Main residence: residence nil-rate band applies and no CGT. Buy-to-let and second homes: deferred CGT on the gain.',
  'property.label':'Address or name. Recorded only.',
  'property.value':'Current market value before the household share is applied.',
  'property.share':'Household’s share of the property, e.g. 50% if owned with someone outside the household.',
  'property.baseCost':'Purchase cost plus improvements, used for the deferred CGT on investment property.',
  'other.owner':'Owner for IHT and CGT.','other.type':'Private company shares, partnership capital, collectibles or loans owed to the household.',
  'other.label':'Description. Recorded only.','other.value':'Current value. Adds to real assets.',
  'other.baseCost':'Cost for the deferred CGT estimate.',
  'other.badr':'Business Asset Disposal Relief: the lower CGT rate applies to the gain on disposal.',
  'other.bpr':'Business Relief: the asset is excluded from the IHT estate.',
  'liabilities.owner':'Borrower for the per-person balance sheet view.',
  'liabilities.type':'Mortgage, buy-to-let mortgage, loan, credit card. Recorded for the file.',
  'liabilities.lender':'Recorded only.','liabilities.balance':'Outstanding balance today. This is the debt on the balance sheet.',
  'liabilities.rate':'Recorded for the file and reviews.','liabilities.fixedUntil':'Recorded for the file and reviews.',
  'liabilities.payment':'Monthly payment × 12 is debt service, added to essential outgoings for months of cover.',
  'liabilities.term':'Recorded for the file.','liabilities.interestOnly':'Recorded for the file: an interest-only loan needs a repayment plan in the review.',
  'protection.owner':'The life assured. Life cover is compared with this person’s human capital.',
  'protection.type':'Life cover and family income benefit count towards the protection gap and the estate. Income protection and critical illness are recorded.',
  'protection.provider':'Recorded only.',
  'protection.sum':'Sum assured, or the benefit per year for income-type policies.',
  'protection.inTrust':'Cover not written in trust is paid into the estate and may attract IHT.',
  'protection.expiryAge':'Recorded for the file and reviews.','protection.premium':'Recorded for the costs summary.',
  'models.name':'Shown in the mandate\u2019s model list.','models.riskMin':'Lowest risk tolerance (1\u20137) this model suits. The mandate check flags an agreed risk outside the range.','models.riskMax':'Highest risk tolerance this model suits.',
  'models.benchmark':'Used on the mandate and, from Stage 3, for performance comparison.','models.description':'Who the model is designed for. Shown to advisers when choosing.',
  'models.ukEq':'Target weight. All eight must add up to 100%.','models.glEq':'Target weight.','models.emEq':'Target weight.','models.gilts':'Target weight.','models.corp':'Target weight.','models.prop':'Target weight.','models.alt':'Target weight.','models.cash':'Target weight.',
  'mandate.model':'The firm\u2019s model this household follows. Its allocation becomes the target in the mandate check.','mandate.objective':'Recorded for the IPS and the suitability report.',
  'mandate.incomeNeed':'Natural income the portfolio must produce. Recorded for the IPS; compared with portfolio yield from Stage 3.','mandate.horizon':'Years until the money is needed. Recorded for the IPS.',
  'mandate.agreedOn':'Until this is set, the mandate check shows the mandate as not yet agreed.','mandate.agreedBy':'Who agreed it on the client side.','mandate.notes':'Anything else agreed.',
  'contacts.date':'When the contact happened.','contacts.type':'Review meeting resets the annual suitability review to 12 months later. Life event creates a reassess-suitability item until the next review meeting.',
  'contacts.with':'Who took part: client names, adviser, paraplanner.','contacts.by':'Who wrote the note.','contacts.summary':'What was discussed and agreed. Part of the permanent file.',
  'actions.created':'When the task was raised.','actions.description':'What needs doing.','actions.owner':'Team member responsible. The list comes from Firm settings › Team members.',
  'actions.priority':'High-priority tasks sort first on the Tasks board.','actions.due':'Open tasks with a due date appear in Reviews due and on the Tasks board; overdue ones are highlighted.',
  'actions.status':'Anything other than Done or Cancelled counts as open. Waiting on client / provider shows where the task is held up.','actions.doneOn':'Date completed.','actions.notes':'Progress notes.',
  'rtq.owner':'The adult this questionnaire belongs to. Results are written to their record under People.','rtq.completedOn':'Date the client answered. Repeat at each annual review.','rtq.by':'Adviser who took the client through it.',
  'loas.provider':'From Firm settings › Providers. The provider\u2019s address or email is printed on the letter.','loas.owner':'The plan holder. Their name, date of birth, NI number and address are printed on the letter.',
  'loas.planType':'Printed on the letter.','loas.policyRef':'Printed on the letter. Blank asks the provider to identify every plan in the client\u2019s name.','loas.employer':'Helps the provider find workplace scheme records.',
  'loas.reqValue':'Included in the list of information requested.','loas.reqTransfer':'Included in the list of information requested.','loas.reqFunds':'Included in the list of information requested.','loas.reqCharges':'Included in the list of information requested.',
  'loas.reqContrib':'Included in the list of information requested.','loas.reqGuarantees':'Ask whenever a transfer might be considered: safeguarded benefits trigger extra advice requirements.','loas.reqDeath':'Included in the list of information requested.','loas.reqRetire':'Included in the list of information requested.','loas.otherRequest':'Added to the list as written.',
  'loas.status':'Drafted or With client: a signature reminder after 14 days. Signed: a send-to-provider reminder. Sent: a chase reminder after the chase period. Information received or Cancelled clears it.',
  'loas.createdOn':'Starts the 14-day signature reminder.','loas.signedOn':'Date the client signed.','loas.sentOn':'Starts the provider chase reminder.','loas.sentBy':'How the letter went.','loas.chaseDays':'Days after sending before Reviews due asks you to chase the provider.','loas.receivedOn':'Date the information arrived.','loas.notes':'Provider reference, call notes.',
  'firm.name':'Printed on letters and documents.','firm.frn':'Your FCA firm reference number.','firm.address':'Printed on the letterhead.','firm.phone':'Printed on letters.','firm.email':'Where providers send information requested under a letter of authority.','firm.website':'Printed on letters.','firm.signatory':'Name printed under the adviser signature.',
  'team.name':'Appears in the Assigned to list on tasks.','team.role':'Shown beside the name.','team.email':'For reference.','team.active':'Inactive members drop out of the Assigned to list; their existing tasks keep the name.',
  'providers.name':'Shown when choosing the provider on a letter of authority.','providers.kind':'Pension, platform, insurer and so on.','providers.address':'Postal address printed on the letter. Check against the provider\u2019s adviser guidance.',
  'providers.email':'Email address for letters of authority, if the provider accepts them by email.','providers.portal':'Adviser portal or Origo route, if used instead of post or email.','providers.notes':'Anything the team should know, e.g. wet signature required.',
  'complaints.received':'Date the complaint was received. DISP requires a final response within 8 weeks of this date.','complaints.summary':'The complaint in the client\u2019s words.',
  'complaints.stage':'Received, Acknowledged, Investigating, Final response sent, Referred to FOS or Closed. The 8-week deadline shows in Reviews due until a final response is sent.',
  'complaints.outcome':'Upheld, partly upheld or not upheld, for the complaints register and FCA returns.','complaints.redress':'Compensation or redress paid.','complaints.closedOn':'Date the complaint was closed.','complaints.notes':'Handling notes: who investigated, evidence, root cause.',
  'compliance.serviceType':'Advisory, discretionary or execution-only. Sets the mandate and the documents required.',
  'compliance.categorisation':'Retail, professional or eligible counterparty under COBS 3. Retail clients get the fullest protections.',
  'compliance.meeting':'Not met face to face adds 1 AML point and requires stronger identity verification.',
  'compliance.referral':'Introducer or source of the lead. Recorded for the file.',
  'compliance.purpose':'Purpose and intended nature of the relationship is a required CDD record (MLR 2017 reg. 28).',
  'compliance.expectedInvestment':'Expected amount. Large investments add an AML point relative to the source of wealth.',
  'compliance.fundsCountry':'Country the money is coming from. A high-risk third country makes the rating High.',
  'compliance.fundsRoute':'Third-party payment adds 2 AML points; a non-UK bank account adds 1.',
  'compliance.complexStructure':'Trusts, companies or offshore structures add AML points and need beneficial ownership recorded.',
  'compliance.cashIntensive':'Cash-intensive business or wealth adds AML points.',
  'compliance.termsDate':'Client agreement signed. A blocker until recorded.',
  'compliance.feeDate':'Fee agreement signed. A blocker until recorded.',
  'compliance.costsDate':'Ex-ante costs and charges disclosure (MiFID II). A blocker until recorded.',
  'compliance.privacyDate':'Privacy notice provided (UK GDPR). A blocker until recorded.',
  'compliance.marketingConsent':'Recorded for the file. Not required for onboarding.',
  'compliance.targetMarket':'PROD target market check: the service and products match this client type.',
  'compliance.suitabilityDate':'Date the suitability report was issued. Required under COBS 9A before advice is acted on.',
  'compliance.seniorApprovalDate':'Date senior management approved the relationship. Required for PEPs.',
  'compliance.preparer':'Who prepared the file. Must differ from the reviewer.',
  'compliance.preparedDate':'Recorded for the audit trail.',
  'compliance.reviewDate':'Date of the compliance review. The next review is set from this date and the AML rating.',
  'compliance.outcome':'Approved, approved with conditions or declined. Approval with open blockers shows as "Approved with open issues".',
  'compliance.reviewNotes':'Reviewer’s notes for the file.',
  'assumptions.cpi':'Inflates spending and goals, and the default inflation for spending lines.',
  'assumptions.rf':'Gilt yield used to discount every future cash flow. Higher = lower present values on both sides.',
  'assumptions.spIndex':'Growth applied to State Pension income (triple lock proxy).',
  'assumptions.planAge':'Age at which the plan ends. Spending, income rights and the horizon run to this age.',
  'assumptions.gM':'Modal age at death for men in the Gompertz mortality model. Health and smoking shift it.',
  'assumptions.gF':'Modal age at death for women in the Gompertz mortality model.',
  'assumptions.gB':'Dispersion of the mortality curve around the modal age. Larger = flatter survival curve.',
  'assumptions.pLow':'Discount premium over gilts for very stable earnings (public sector).',
  'assumptions.pMed':'Discount premium for stable salaried earnings.','assumptions.pHigh':'Discount premium for variable earnings (commission, partnership).',
  'assumptions.pVhigh':'Discount premium for volatile earnings (founders, freelancers).',
  'assumptions.hcAfterTax':'Value human capital after income tax and NI (recommended) or gross.',
  'assumptions.pa':'Income tax personal allowance.','assumptions.brl':'Income above this is taxed at the higher rate.',
  'assumptions.arl':'Income above this is taxed at the additional rate.','assumptions.paTaper':'Personal allowance reduces by £1 for every £2 above this income.',
  'assumptions.r1':'Basic rate of income tax.','assumptions.r2':'Higher rate.','assumptions.r3':'Additional rate.',
  'assumptions.d1':'Dividend tax at the basic rate band.','assumptions.d2':'Dividend tax at the higher rate band.','assumptions.d3':'Dividend tax at the additional rate band.',
  'assumptions.divAll':'Dividends within this allowance are tax free.','assumptions.psaB':'Personal savings allowance for basic-rate taxpayers.',
  'assumptions.psaH':'Personal savings allowance for higher-rate taxpayers (nil for additional rate).',
  'assumptions.srs':'Starting rate band for savings income when other income is low.',
  'assumptions.ni1':'Employee National Insurance main rate.','assumptions.ni2':'Employee NI rate above the upper earnings limit.',
  'assumptions.c41':'Class 4 NI main rate for the self-employed.','assumptions.c42':'Class 4 NI rate above the upper limit.',
  'assumptions.hicbc':'High income child benefit charge starts at this adjusted net income.',
  'assumptions.isa':'Annual ISA subscription limit, checked against contributions.','assumptions.lisa':'Lifetime ISA limit, within the ISA allowance.',
  'assumptions.jisa':'Junior ISA limit per child.','assumptions.aa':'Pension annual allowance across all schemes, including employer contributions.',
  'assumptions.mpaa':'Money Purchase Annual Allowance once pension income has been flexibly accessed.',
  'assumptions.aaMin':'Minimum tapered annual allowance for the highest earners.',
  'assumptions.tThresh':'Taper threshold income: below this the annual allowance is not tapered.',
  'assumptions.tAdj':'Taper adjusted income: the allowance reduces £1 for every £2 above this.',
  'assumptions.lsa':'Pension lump sum allowance: the tax-free cash limit used in deferred pension tax.',
  'assumptions.spFull':'Full new State Pension per week, pro-rated by NI qualifying years.',
  'assumptions.cgtAE':'Capital gains annual exempt amount.','assumptions.cgtL':'CGT rate for basic-rate taxpayers.',
  'assumptions.cgtH':'CGT rate for higher-rate taxpayers, used for deferred CGT.','assumptions.badrRate':'CGT rate under Business Asset Disposal Relief.',
  'assumptions.nrb':'IHT nil-rate band per person; doubled for married couples and civil partners.',
  'assumptions.rnrb':'Residence nil-rate band when a main residence passes to direct descendants.',
  'assumptions.rnrbTaper':'The residence band reduces £1 for every £2 of estate above this.',
  'assumptions.ihtRate':'IHT rate on the estate above the available bands.',
  'assumptions.pensionIHT':'From April 2027 unused pensions are in the estate. Tick to include them in the IHT estimate.'};
const GROUP_HELP={
  'Identity':'Personal details and NI number for customer due diligence.',
  'Contact and address':'Verified residential address. Proof of address must be within 3 months.',
  'Identity verification':'Photo ID, how it was checked and when. Expired ID is a blocker.',
  'Screening':'Sanctions, PEP and adverse media results, entered by hand from your screening provider. Must be within 3 months.',
  'Source of wealth and tax status':'How the wealth was built, the evidence seen, and CRS/FATCA tax residence data.',
  'Work and retirement':'Employment and retirement age set the human capital calculation.',
  'Tax and residence':'Residence, NI record and expected retirement tax rate for the Tax view and deferred pension tax.',
  'Investor profile and suitability':'Willingness and capacity for loss, knowledge and experience, and vulnerability: the suitability record.',
  'The relationship':'Service, categorisation, how the client was met and where the money comes from. These set the AML score.',
  'Enhanced due diligence':'Required when the rating is High: EDD findings, verified source of wealth and senior approval.',
  'Disclosures and consents':'Documents the client must receive or sign before onboarding completes.',
  'Sign-off':'Four-eyes review: the reviewer must differ from the preparer.',
  'Attitude to risk':'Nine questions scored 1–5; the total sets risk tolerance 1–7. The 25% fall question sets the loss reaction.','Capacity for loss':'Six questions scored −1/0/+1; the total sets capacity low, medium or high.','Knowledge and experience':'Three questions scored 0–3; the total sets the knowledge level.','Client and date':'Who answered, when and with whom.',
  'Plan':'Which plan the letter is about, and whose it is.','Information requested':'Each ticked item is listed in the letter.','Progress':'Where the letter is. Drives the reminders in Reviews due.',
  'Service and model':'Which model the portfolio follows and the risk level agreed. These set the target allocation.',
  'Objectives and constraints':'What the portfolio is for and what it may not hold. Recorded for the IPS; the drift tolerance drives the mandate check.',
  'Agreement':'When the mandate was agreed and last reviewed. Sets the annual mandate review date.',
  'Economic':'Inflation, discount rate, mortality and horizon that drive every present value.',
  'Income tax and NI (rest of UK)':'Bands and rates for the Tax view and after-tax human capital.',
  'Wrappers and pensions':'ISA and pension allowances for the allowance checks and deferred pension tax.',
  'Capital gains and inheritance tax':'CGT rates for deferred tax and IHT bands for the second-death estimate.'};
const NAV_HELP={rtq:'Scored risk questionnaire: sets risk tolerance, capacity for loss and experience.',loas:'Letters asking providers to release plan information.',mandate:'The investment mandate agreed with the client.',models:'The firm\u2019s risk-rated model portfolios.',drift:'Mandate against the current portfolio and the risk profile.',contacts:'Meetings, calls, review meetings and life events.',actions:'Tasks assigned to team members, with due dates and status.',complaints:'Complaints handled under DISP.',reviews:'Every dated obligation for this household.',household:'The file, legal status and legacy wish.',members:'Everyone in the household: ages, work, KYC and suitability.',income:'Earnings become human capital; pensions and benefits become income rights.',
  expenses:'Future spending, valued today as a liability.',goals:'One-off capital needs, valued today.',accounts:'Cash, ISAs, pensions and investments.',db:'Final salary pensions not yet in payment.',property:'Homes and investment property.',
  other:'Business interests and other assets.',liabilities:'Mortgages and debts.',protection:'Life and health cover.',assumptions:'Tax rules and economic assumptions behind every figure.',
  compliance:'Relationship, AML factors, disclosures and sign-off.',kyc:'Onboarding status worked out from everything recorded.',audit:'Who changed what, and when.',
  bs:'Present value of everything owned, earned and committed.',tax:'Income tax, NI and unused allowances per person.',risk:'Ability and willingness to take risk, and the IPS.',checks:'Data gaps and inconsistencies to fix.',guide:'How the calculations and onboarding rules work.'};
const tipBtn=(label,text,cls='')=>text?`<button type="button" class="tip ${cls}" aria-label="About ${esc(label)}" data-tip="${esc(text)}">i</button>`:'';

const FIRM_KEYS=new Set(['firm','team','providers']);
const recs=col=>FIRM_KEYS.has(col)?Store.firm.settings[col]:S[col];
/* ---------- form rendering ---------- */
function teamOptions(val){const t=((Store.firm.settings||{}).team||[]).filter(m=>m.name&&(yes(m.active)||m.name===val)).map(m=>[m.name,`${m.name}${m.role?' · '+m.role:''}`]);
  if(val&&!t.some(o=>o[0]===val))t.push([val,val+' (not in team list)']);return t}
function providerOptions(val){const t=((Store.firm.settings||{}).providers||[]).filter(p=>p.name).map(p=>[p.name,p.name]);if(val&&!t.some(o=>o[0]===val))t.push([val,val]);return t}
function ownerOptions(withJoint){let o=withJoint?[['JOINT','Joint (adults equally)']]:[];return o.concat(S.members.map(m=>[m.ref,`${m.ref} · ${m.firstName||''} ${m.lastName||''}`.trim()]))}
const VALIDATE={niNumber:v=>!v||H.validNino(v)?'':'Not a valid NI number',postcode:v=>!v||H.validPostcode(v)?'':'Check the postcode format',email:v=>!v||H.validEmail(v)?'':'Check the email address'};
function fieldHTML(col,idx,f,val){
  const id=`f-${col}-${idx}-${f.k}`;const data=`data-col="${col}" data-idx="${idx}" data-k="${f.k}"${FIRM_KEYS.has(col)?' data-scope="firm"':''}`;
  const vmsg=VALIDATE[f.k]?VALIDATE[f.k](val):'';
  const hint=vmsg?`<span class="hint err" id="${id}-h">${esc(vmsg)}</span>`:f.h?`<span class="hint" id="${id}-h">${esc(f.h)}</span>`:'';
  const aria=(vmsg||f.h?` aria-describedby="${id}-h"`:'')+(vmsg?' aria-invalid="true"':'');
  const tip=tipBtn(f.l,FIELD_HELP[`${col}.${f.k}`]||f.h);
  if(f.t===YN)return `<div class="f chk"><input type="checkbox" id="${id}" ${data} ${yes(val)?'checked':''}><span class="lab"><label for="${id}">${esc(f.l)}</label>${tip}</span></div>`;
  let ctl;
  if(f.t==='sel'||f.t==='member'||f.t==='owner'||f.t==='model'||f.t==='team'||f.t==='provider'){const opts=f.t==='sel'?optList(f.o):f.t==='model'?S.models.map(m=>[m.name,m.name]):f.t==='team'?teamOptions(val):f.t==='provider'?providerOptions(val):ownerOptions(f.t==='owner');const known=opts.some(o=>String(o[0])===String(val));
    ctl=`<select id="${id}" ${data}${aria}>${(f.t!=='sel'||!known)?`<option value="">${f.t==='sel'?'Select…':f.t==='model'?'Select model…':f.t==='team'?'Unassigned':f.t==='provider'?'Select provider…':'Select person…'}</option>`:''}${opts.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(val)?'selected':''}>${esc(l)}</option>`).join('')}</select>`}
  else if(f.t==='area')ctl=`<textarea id="${id}" ${data}${aria}>${esc(val)}</textarea>`;
  else if(f.t==='date')ctl=`<input type="date" id="${id}" ${data}${aria} value="${esc(val)}">`;
  else if(f.t==='num'||f.t==='pct'||f.t==='int')ctl=`<input type="number" inputmode="decimal" step="${f.t==='int'?1:'any'}" id="${id}" ${data}${aria} value="${esc(val)}">`;
  else ctl=`<input type="text" id="${id}" ${data}${aria} value="${esc(val)}" autocomplete="off">`;
  return `<div class="f${f.w?' wide':''}"><span class="lab"><label for="${id}">${esc(f.l)}</label>${tip}</span>${ctl}${hint}</div>`;
}
function fieldsBlock(key,idx,rec){const s=SCHEMA[key];
  if(s.groups)return s.groups.filter(g=>!(g.adultOnly&&key==='members'&&!isAdult(rec))).map(g=>`<div class="grp"><h4>${esc(g.t)}${tipBtn(g.t,GROUP_HELP[g.t])}</h4><div class="fields">${g.fields.map(f=>fieldHTML(key,idx,f,rec[f.k])).join('')}</div></div>`).join('');
  return `<div class="fields">${s.fields.map(f=>fieldHTML(key,idx,f,rec[f.k])).join('')}</div>`}
function summary(key,r){
  const who=r.owner?memberName(r.owner):'';
  switch(key){
    case 'members':{const a=E.ageOf(r);return [`${r.ref||'?'} · ${r.firstName||'Unnamed'} ${r.lastName||''}`,`${(ROLES.find(x=>x[0]===r.role)||[0,''])[1]} · ${a!=null?'age '+Math.floor(a):'no date of birth'}${r.employment&&isAdult(r)?' · '+r.employment:''}`,''];}
    case 'income':return [r.type,`${who}${r.label?' · '+r.label:''}`,gbp(N(r.amount))+' p.a.'];
    case 'expenses':return [r.label||'Spending',(EXP_CATS.find(x=>x[0]===r.cat)||[0,''])[1]+(has(r.duration)?` · ${r.duration} yrs`:''),gbp(N(r.amount))+' p.a.'];
    case 'goals':return [r.label||'Goal',`in ${N(r.inYears)} years · ${r.priority||''}`,gbp(N(r.amount))];
    case 'accounts':return [r.wrapper,`${who}${r.provider?' · '+r.provider:''}`,gbp(N(r.value))];
    case 'db':return [r.scheme||'DB scheme',`${who} · ${r.status} · NRA ${r.nra}`,gbp(N(r.accrued))+' p.a.'];
    case 'property':case 'other':return [r.type,`${who}${r.label?' · '+r.label:''}`,gbp(N(r.value))];
    case 'liabilities':return [r.type,`${who}${r.lender?' · '+r.lender:''}${has(r.rate)?' · '+r.rate+'%':''}`,gbp(N(r.balance))];
    case 'protection':return [r.type,`${who}${yes(r.inTrust)?' · in trust':''}`,gbp(N(r.sum))];
    case 'models':{const eq=N(r.ukEq)+N(r.glEq)+N(r.emEq);return [r.name||'Model',`risk ${r.riskMin||'?'}–${r.riskMax||'?'}${r.benchmark?' · '+r.benchmark:''}`,`${eq}% equity`]}
    case 'contacts':return [r.type||'Contact',`${fmtDate(r.date)}${r.with?' · '+r.with:''}`,''];
    case 'actions':return [r.description||'Task',`${r.owner||'Unassigned'}${r.due?' · due '+fmtDate(r.due):''}${r.priority==='High'?' · high priority':''}`,r.status||''];
    case 'rtq':{const sc=H.rtqScore(r);return [r.owner?memberName(r.owner):'Choose the client',`${sc.answered} of ${sc.of} answered${r.completedOn?' · '+fmtDate(r.completedOn):''}`,sc.complete?`Risk ${sc.atr.band} · capacity ${sc.cfl.level}`:'Incomplete']}
    case 'loas':return [`${r.provider||'Provider'}${r.policyRef?' · '+r.policyRef:''}`,`${r.owner?memberName(r.owner):'No client'} · ${r.planType||''}${r.sentOn?' · sent '+fmtDate(r.sentOn):''}`,r.status||''];
    case 'team':return [r.name||'Team member',`${r.role||''}${r.email?' · '+r.email:''}`,yes(r.active)?'':'Inactive'];
    case 'providers':return [r.name||'Provider',`${r.kind||''}${r.email?' · '+r.email:r.address?' · postal':''}`,r.address||r.email||r.portal?'':'Add contact details'];
    case 'complaints':return [(r.summary||'Complaint').slice(0,70),`received ${fmtDate(r.received)} · ${r.stage||''}`,r.outcome||''];
  }return ['','',''];
}
function bannerHTML(household=true){let h='';
  if(household&&S&&S.isSample)h+=`<div class="banner sample"><div><b>Sample household.</b> These are made-up figures to show how the model works. Replace them with client data, import a file, or start blank.</div></div>`;
  if(banner)h+=`<div class="banner ${banner.cls||''}"><div>${banner.html}</div>${banner.sticky?'':'<button class="btn ghost x" type="button" data-act="closeBanner" aria-label="Dismiss">✕</button>'}</div>`;
  return h}
/* ---------- explaining impact ----------
   Each input section shows (1) which outputs it feeds and what its fields change, and (2) a live
   read-out of the headline figures compared with when the section was opened, updated as you type. */
const HOW={
  household:{feeds:['IHT','Funded ratio','Data checks'],pts:[
    'Relationship status: married couples and civil partners get two nil-rate bands against IHT on second death; other couples get one.',
    'Gifts in the last 7 years reduce the nil-rate band available.',
    "Legacy target is added to the liabilities side, inflated and discounted to today's money, so a larger target lowers the funded ratio.",
    'Wills, powers of attorney and trusts do not change the figures. Missing wills are flagged in Data checks.',
    'UK nation: Scotland flags that Scottish income tax bands apply, which are not modelled.']},
  members:{feeds:['Human capital','Life expectancy','KYC and AML','Risk profile','Tax'],pts:[
    'Date of birth, sex, health and smoking set the assumed life expectancy, which weights every future cash flow. A shorter life expectancy lowers both human capital and the value of future spending.',
    'Income stability sets the discount premium on earnings and how equity-like they are: volatile earnings are valued lower and count as more equity exposure.',
    'Planned retirement age sets how many years of earnings count (65 if blank).',
    'Photo ID, document expiry, proof of address, screening dates and PEP status drive the KYC status. Expired ID, or proof and screening older than 3 months, are blockers.',
    'Risk attitude, loss reaction, knowledge and capacity for loss feed the risk profile and are required for suitability.']},
  income:{feeds:['Human capital','Income rights','Tax','Funded ratio'],pts:[
    'Earnings (salary, bonus, self-employment profit, dividends) become human capital: the after-tax value of future pay to retirement, weighted by survival and discounted at the gilt rate plus a stability premium.',
    'Pensions in payment, annuities and benefits become income rights valued at the gilt rate.',
    'Growth % compounds the amount each year. Starts at and Ends at age bound the stream; a blank end age means retirement age for earnings and the plan end age for other income.',
    'Taxable lines feed the Tax and allowances view. Untick for tax-free income.']},
  expenses:{feeds:['Liabilities side','Core funded ratio','Liquidity'],pts:[
    'Each line is inflated (at its own rate, or CPI) and discounted at the gilt rate, then added to the liabilities side of the balance sheet.',
    'Essential spending that has already started counts in the core funded ratio and in months of cash cover. Other categories affect only the full funded ratio.',
    'Starts in and Lasts (years) bound the stream, for example school fees for 7 years or care costs starting in 35 years.',
    'Leave mortgage payments out: the balance is already under Liabilities.']},
  goals:{feeds:['Liabilities side','Funded ratio'],pts:[
    "Each goal is a one-off liability on its date, inflated and discounted back to today's money. A goal due sooner is discounted less and weighs more.",
    'Priority is recorded for the investment policy statement. It does not change the figures.']},
  accounts:{feeds:['Financial assets','Deferred tax','Allowances','Equity exposure','Liquidity'],pts:[
    'Value adds to financial assets. Pension wrappers carry deferred tax on withdrawal; taxable accounts carry deferred capital gains tax on value above base cost.',
    'Contributions this tax year drive the ISA and pension annual allowance checks on the Tax view.',
    'The equities, bonds, cash and alternatives split sets the portfolio equity exposure compared with risk tolerance.',
    'Income yield feeds the taxable income estimate. Uncalled commitments are shown as a future call on cash.',
    'Cash and easy-access accounts count towards months of essential outgoings covered.']},
  db:{feeds:['Pension rights','Funded ratio','IHT'],pts:[
    'Accrued pension is valued as an income right from normal retirement age, indexed at the rate given, weighted by survival and discounted at the gilt rate.',
    "For married couples the spouse's pension % adds the value of the survivor's pension.",
    'The CETV is shown for comparison only. The balance sheet uses the economic value of the promised income, not the transfer value.']},
  property:{feeds:['Real assets','IHT','Deferred CGT'],pts:[
    'Market value × household share adds to real assets.',
    'A main residence qualifies for the residence nil-rate band (capped at its net value, tapered above a £2m estate) and is exempt from CGT.',
    'Purchase cost sets the deferred CGT on investment property.',
    'Record mortgages under Liabilities and rent under Income.']},
  other:{feeds:['Real assets','IHT','Deferred CGT'],pts:[
    'Value adds to real assets; base cost sets the deferred CGT.',
    'Business Relief eligible assets are taken out of the IHT estate.',
    'Business Asset Disposal Relief applies the lower CGT rate to the gain.']},
  liabilities:{feeds:['Debt','Core funded ratio','Liquidity'],pts:[
    'Balance is the debt on the economic balance sheet. The core funded ratio measures assets against debt, essential spending and deferred tax.',
    'Monthly payment × 12 is debt service, added to essential outgoings for the months-of-cash measure.',
    'Lender, fixed-until date and remaining term are recorded for the file and do not change the figures.']},
  protection:{feeds:['Protection gap','IHT estate'],pts:[
    "Life cover and family income benefit are compared with each earner's human capital to show the protection gap.",
    'Cover not written in trust is added to the IHT estate.',
    'Expiry age and premium are recorded for the file.']},
  compliance:{feeds:['AML rating','KYC status','Sign-off'],pts:[
    'How the client was met, the funds route and country, structures, high-risk country links and cash-intensive wealth each add AML points: 0–1 low, 2–3 medium, 4 or more high.',
    'A PEP or a high-risk third country is always high and requires EDD findings and verified source of wealth. PEPs also need named senior approval.',
    'Client agreement, fee agreement, costs disclosure and privacy notice are blockers until recorded.',
    'The reviewer must be a different person from the preparer. An approval with open blockers shows as Approved with open issues.']},
  contacts:{feeds:['Reviews due','Audit trail'],pts:[
    'A Review meeting resets the annual suitability review: the next one falls 12 months later.',
    'A Life event (marriage, inheritance, redundancy, retirement, a health change) creates a reassess-suitability item that stays until a review meeting is recorded after it.',
    'Other entries build the contact history for the file. None of them change the figures.']},
  rtq:{feeds:['Risk profile','People','KYC status','Mandate check'],pts:[
    'Every answer has a fixed score and every total a fixed band, shown in "How the scores are worked out" below. Two advisers with the same answers get the same result.',
    'When all 19 questions are answered, the results are written to the person\u2019s record: risk tolerance (1–7), loss reaction, capacity for loss and knowledge and experience. The audit trail records the change.',
    'The risk profile then combines willingness from the questionnaire with ability from the balance sheet, and the mandate check tests the agreed risk level against it.',
    'KYC status lists any adult without a completed questionnaire, or whose record no longer matches it.']},
  loas:{feeds:['Letter','Reviews due'],pts:[
    'Letter builds a print-ready letter from the firm\u2019s details (Firm settings), the provider\u2019s address (provider directory) and the client\u2019s identity details (People). Anything missing is listed above the letter.',
    'Reviews due reminds you to get the client\u2019s signature after 14 days, to send a signed letter, and to chase the provider once the chase period has passed.',
    'Record what arrives against Savings and investments or Defined benefit pensions so the balance sheet uses it.']},
  actions:{feeds:['Tasks board','Reviews due'],pts:[
    'Each task is assigned to a team member from Firm settings and appears on the firm-wide Tasks board, filterable by person.',
    'Open tasks with a due date appear in Reviews due, overdue ones first.',
    'Mark a task Done or Cancelled to clear it; the audit trail keeps the history.']},
  complaints:{feeds:['Reviews due','Compliance MI'],pts:[
    'DISP requires a final response within 8 weeks of receipt. The deadline appears in Reviews due until the stage is Final response sent, Referred to FOS or Closed.',
    'Outcome and redress are recorded for the complaints register and FCA returns.']},
  mandate:{feeds:['Mandate check','Reviews due','KYC status'],pts:[
    'The chosen model portfolio sets the target allocation; the mandate check compares it with the current accounts and flags any class outside the drift tolerance.',
    'The agreed risk level is checked against the model\u2019s range and against the risk profile. Agreeing a level outside the profile requires a written rationale under Onboarding and compliance.',
    'Until a model and risk level are recorded, the KYC status carries a suitability item to review.',
    'The agreement date starts the annual mandate review in Reviews due. Record the last review date to reset it.']},
  models:{feeds:['Mandate','Mandate check'],pts:[
    'Each model is a target allocation across the eight asset classes with a risk range and a benchmark. Allocations must add up to 100%; Data checks flags any that do not.',
    'The five defaults are benchmarked to the ARC Private Client Indices. Edit them to the firm\u2019s own models; changes apply to this household\u2019s file.',
    'The eight classes roll up to equities, bonds, property and alternatives, and cash for the comparison with accounts.']},
  assumptions:{feeds:['Every output'],pts:[
    'The gilt rate discounts every future cash flow. A higher rate lowers human capital, pension rights and the value of future spending at the same time; the net effect shows in the funded ratio.',
    'CPI inflates spending and goals. The gap between inflation and the gilt rate is what matters.',
    'Mortality ages, dispersion and plan-to age set the survival weights and the horizon.',
    'Tax bands and allowances drive the Tax view and the deferred tax on pensions and gains.']}};
const HOW_LS='hwp-how-open';const RECORD_ONLY=new Set(['contacts','actions','complaints','mandate','models','loas','rtq']);
function howHTML(key){const w=HOW[key];if(!w)return '';let open=true;try{open=localStorage.getItem(HOW_LS)!=='0'}catch(e){}
  return `<div class="how"><div class="how-h"><b>How this section is used</b><span class="feeds">${w.feeds.map(f=>`<span class="feed">${esc(f)}</span>`).join('')}</span></div><details id="howDetails"${open?' open':''}><summary>What the inputs change</summary><ul>${w.pts.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></details></div>`}
document.addEventListener('toggle',e=>{if(e.target.id==='howDetails')try{localStorage.setItem(HOW_LS,e.target.open?'1':'0')}catch(x){}},true);

const sgn=n=>n>0?'+':'−';
const DELTA={
  money:(a,b)=>{const d=b-a;return !isFinite(d)||Math.abs(d)<0.5?null:[sgn(d)+gbpK(Math.abs(d)),Math.sign(d)]},
  ratio:(a,b)=>{if(!isFinite(a)||!isFinite(b))return a===b?null:['changed',0];const d=b-a;return Math.abs(d)<0.005?null:[sgn(d)+Math.abs(d).toFixed(2)+'×',Math.sign(d)]},
  pct:(a,b)=>{const d=(b-a)*100;return !isFinite(d)||Math.abs(d)<0.05?null:[sgn(d)+Math.abs(d).toFixed(1)+' pts',0]},
  count:(a,b)=>{const d=b-a;return d?[sgn(d)+Math.abs(d),Math.sign(d)]:null},
  text:(a,b)=>a===b?null:['was '+a,0]};
function metrics(){const C=E.compute();const k=C.kpi;const T=C.tot.HH;const O=E.onboarding(C);
  const fx=x=>isFinite(x)?x.toFixed(2)+'×':'n/a';
  const fin=[
    {id:'nw',k:'Economic net worth',v:T.A-T.L,f:gbpK,d:DELTA.money,up:'good'},
    {id:'fr',k:'Funded ratio',v:T.L?T.A/T.L:Infinity,f:fx,d:DELTA.ratio,up:'good'},
    {id:'cf',k:'Core funded ratio',v:k.coreFunded,f:fx,d:DELTA.ratio,up:'good'},
    {id:'iht',k:'IHT on second death',v:k.iht,f:gbpK,d:DELTA.money,up:'bad'},
    {id:'eq',k:'Equity exposure',v:k.totalEqPct,f:x=>pct(x),d:DELTA.pct,up:null}];
  const kyc=[
    {id:'st',k:'Onboarding status',v:O.stage,f:String,d:DELTA.text,up:null},
    {id:'aml',k:'AML rating',v:`${O.rating} (score ${O.score})`,f:String,d:DELTA.text,up:null},
    {id:'bl',k:'Blockers',v:O.blockerCount,f:String,d:DELTA.count,up:'bad'},
    {id:'rv',k:'Items to review',v:O.warnCount,f:String,d:DELTA.count,up:'bad'}];
  if(VIEW==='compliance')return kyc;
  if(VIEW==='members')return [fin[0],fin[1],kyc[1],kyc[2],kyc[3]];
  return [...fin,kyc[2]];
}
let IMPACT={view:null,base:{},why:''},impT;
function imCell(m){const base=IMPACT.base[m.id];const d=base===undefined?null:m.d(base,m.v);let cls='';
  if(d&&d[1]&&m.up)cls=(d[1]>0)===(m.up==='good')?'up':'down';
  return `<div class="im" data-m="${m.id}"><div class="k">${esc(m.k)}</div><div class="v">${esc(m.f(m.v))}</div><div class="d ${cls}">${d?esc(d[0]):''}</div></div>`}
function impactHTML(){const ms=metrics();
  if(IMPACT.view!==VIEW)IMPACT={view:VIEW,base:Object.fromEntries(ms.map(m=>[m.id,m.v])),why:''};
  return `<div class="impact" id="impact"><div class="impact-h"><b>Live effect of this section</b><span>Changes are compared with when you opened this section</span></div><div class="impact-grid">${ms.map(imCell).join('')}</div><div class="impact-why" id="impactWhy">${IMPACT.why||'Edit a field below and these figures update as you type.'}</div></div>`}
function refreshImpact(label,f){const el=$('#impact');if(!el)return;const moved=[];
  for(const m of metrics()){const cell=el.querySelector(`.im[data-m="${m.id}"]`);if(!cell)continue;const tmp=document.createElement('div');tmp.innerHTML=imCell(m);const nc=tmp.firstChild;
    if(nc.querySelector('.v').textContent!==cell.querySelector('.v').textContent){moved.push(`${m.k} ${nc.querySelector('.v').textContent}`);nc.classList.add('flash');setTimeout(()=>nc.classList.remove('flash'),800)}
    cell.replaceWith(nc)}
  IMPACT.why=moved.length?`<b>${esc(label)}</b> changed: ${esc(moved.join(' · '))}.`:`<b>${esc(label)}</b> recorded. No change to the figures above${f&&f.h?': '+esc(f.h):'.'}`;
  const w=$('#impactWhy');if(w)w.innerHTML=IMPACT.why}

function renderInput(key){
  const s=SCHEMA[key];let h=`<div class="sec-head"><div><h2>${esc(s.title)}</h2><p>${esc(s.desc||'')}</p></div>`;
  if(!s.single)h+=`<div class="addrow"><button class="btn" type="button" data-act="toggleAll" data-col="${key}">Expand all</button><button class="btn primary" type="button" data-act="add" data-col="${key}">Add ${esc(s.item)}</button></div>`;
  h+=`</div>`+bannerHTML()+(RECORD_ONLY.has(key)?'':impactHTML())+howHTML(key);
  if(s.single){h+=`<div class="card" data-open="true"><div class="card-b" style="border-top:0">${fieldsBlock(key,0,S[key])}</div></div>`;
    if(key==='assumptions')h+=`<p class="note">Figures reflect the 2026/27 tax year as announced. From April 2027 unused pensions fall into the estate for IHT, and savings and property income rates rise by 2 points; update these inputs when they take effect.</p><div class="addrow"><button class="btn" type="button" data-act="resetAssump">Restore defaults</button></div>`;
    if(key==='compliance')h+=`<div class="addrow"><button class="btn" type="button" data-nav="kyc">See onboarding status</button></div>`;
    return h}
  if(!S[key].length)h+=`<div class="empty">Nothing recorded yet. Use “Add ${esc(s.item)}” or import an Excel file.</div>`;
  if(key==='rtq')h+=rtqPanel();
  if(key==='loas'&&S.loas.length)h+=`<p class="note" style="margin:0 0 12px">Open a letter, check the details, then use <b>Letter</b> to print it or save it as PDF for the client to sign.</p>`;
  S[key].forEach((r,i)=>{const [t,meta,v]=summary(key,r);const open=OPEN.has(key+':'+i);
    h+=`<div class="card" data-open="${open}" data-card="${key}:${i}"><div class="card-h" data-act="toggle" data-col="${key}" data-idx="${i}" role="button" tabindex="0" aria-expanded="${open}"><span class="chev">▸</span><span class="sum"><b>${esc(t)}</b><span class="meta">${esc(meta)}</span></span><span class="val">${esc(v)}</span>${key==='loas'?`<button class="btn" type="button" data-act="loaLetter" data-idx="${i}">Letter</button>`:''}<button class="btn ghost" type="button" data-act="del" data-col="${key}" data-idx="${i}">Remove</button></div><div class="card-b">${fieldsBlock(key,i,r)}</div></div>`});
  return h;
}

/* ---------- outputs ---------- */
const GROUPS_A=[['fin','Financial capital'],['real','Real assets'],['hc','Human capital'],['pen','Pension and income rights']];
const GROUPS_L=[['debt','Financial liabilities'],['cons','Consumption goals (PV)'],['goal','Capital goals and legacy (PV)'],['tax','Deferred tax']];
const COLORS={fin:'var(--asset)',real:'var(--asset2)',hc:'var(--hc)',pen:'var(--pen)',debt:'var(--liab)',cons:'var(--liab2)',goal:'var(--liab3)',tax:'var(--muted)'};
function renderBS(){
  const C=E.compute();const v=BSVIEW in C.tot?BSVIEW:'HH';const T=C.tot[v];const k=C.kpi;
  const fr=x=>isFinite(x)?x.toFixed(2)+'×':'n/a';const pill=(x,g,w)=>x>=g?'good':x>=w?'warn':'bad';
  const fv=T.L?T.A/T.L:Infinity;
  let h=`<div class="sec-head"><div><h2>Economic balance sheet</h2><p>Present values of everything the household owns, will earn and has committed to spend, following the CFA Institute private wealth framework. Values are in pounds today.</p></div></div>`+bannerHTML();
  h+=`<div class="kpis">
   <div class="kpi"><div class="k">Economic net worth</div><div class="v">${gbpK(T.A-T.L)}</div><div class="s">Assets ${gbpK(T.A)} less liabilities ${gbpK(T.L)}</div></div>
   <div class="kpi"><div class="k">Funded ratio</div><div class="v">${fr(fv)}</div><div class="s"><span class="pill ${pill(fv,1.2,1)}">${fv>=1.2?'Surplus':fv>=1?'Tight':'Shortfall'}</span></div></div>
   <div class="kpi"><div class="k">Core funded ratio</div><div class="v">${fr(k.coreFunded)}</div><div class="s">Household: against debt, essential spending and tax</div></div>
   <div class="kpi"><div class="k">Human capital share</div><div class="v">${pct(T.A?T.hc/T.A:0)}</div><div class="s">of economic assets</div></div>
   <div class="kpi"><div class="k">Cash runway</div><div class="v">${isFinite(k.cashMonths)?k.cashMonths.toFixed(0)+' mo':'n/a'}</div><div class="s"><span class="pill ${pill(k.cashMonths,12,6)}">${k.cashMonths>=12?'Comfortable':k.cashMonths>=6?'Adequate':'Thin'}</span> essential + debt payments</div></div>
   <div class="kpi"><div class="k">Traditional net worth</div><div class="v">${gbpK(k.tradNW)}</div><div class="s">Market assets less debt</div></div></div>`;
  h+=`<div class="viewbar"><span class="muted" style="font-size:12.5px;margin-right:4px">View</span><div class="seg" role="group" aria-label="Balance sheet view">${C.views.map(x=>`<button type="button" data-act="bsview" data-v="${esc(x)}" aria-pressed="${x===v}">${x==='HH'?'Household':esc(memberName(x))}</button>`).join('')}</div></div>`;
  const max=Math.max(T.A,T.L)||1;const bar=groups=>groups.map(([g,l])=>T[g]>0?`<i style="width:${(T[g]/max*100).toFixed(2)}%;background:${COLORS[g]}" title="${esc(l)}: ${gbp(T[g])}"></i>`:'').join('');
  h+=`<div class="comp"><h3>Composition</h3>
    <div class="barrow"><span class="lbl">Assets</span><div class="bar">${bar(GROUPS_A)}</div><span class="tot">${gbpK(T.A)}</span></div>
    <div class="barrow"><span class="lbl">Liabilities</span><div class="bar">${bar(GROUPS_L)}</div><span class="tot">${gbpK(T.L)}</span></div>
    <div class="legend">${[...GROUPS_A,...GROUPS_L].map(([g,l])=>`<span><i style="background:${COLORS[g]}"></i>${esc(l)}</span>`).join('')}</div></div>`;
  const side=(sd,groups,cls,title)=>{let rows='';for(const [g,l] of groups){const ls=C.lines.filter(x=>x.side===sd&&x.group===g);const agg={};for(const x of ls){const val=C.val(x,v);if(Math.abs(val)<0.5)continue;agg[x.label]=agg[x.label]||{v:0,note:x.note};agg[x.label].v+=val}
      const ent=Object.entries(agg);rows+=`<tr class="g"><td>${esc(l)}</td><td class="n">${gbp(T[g])}</td></tr>`;
      if(!ent.length)rows+=`<tr class="sub"><td class="muted">None recorded</td><td class="n muted">–</td></tr>`;
      for(const [lab,o] of ent)rows+=`<tr class="sub"><td>${esc(lab)}${o.note?` <span class="muted">· ${esc(o.note)}</span>`:''}</td><td class="n">${gbp(o.v)}</td></tr>`}
    rows+=`<tr class="t"><td>Total ${sd==='A'?'economic assets':'economic liabilities'}</td><td class="n">${gbp(T[sd])}</td></tr>`;
    return `<div class="panel ${cls}"><h3>${title}</h3><div class="tbl-wrap"><table><tbody>${rows}</tbody></table></div></div>`};
  h+=`<div class="bs">${side('A',GROUPS_A,'side-a','Assets')}${side('L',GROUPS_L,'side-l','Liabilities')}</div>`;
  h+=`<div class="panel"><h3>Memorandum items</h3><div class="tbl-wrap"><table><tbody>
    <tr><td>Estimated IHT on second death (today)</td><td class="n">${gbp(k.iht)}</td></tr>
    <tr><td class="muted">Estate ${gbp(k.estate)} · nil-rate bands ${gbp(k.nrb)} · residence band ${gbp(k.rnrb)}${yes(S.assumptions.pensionIHT)?' · pensions included':''}${k.coverInEstate?` · ${gbp(k.coverInEstate)} life cover not in trust`:''}</td><td></td></tr>
    <tr><td>Uncalled private-market commitments</td><td class="n">${gbp(k.uncalled)}</td></tr>
    <tr><td>Life and death-in-service cover in force</td><td class="n">${gbp(k.lifeCover)}</td></tr>
    <tr><td>Planning horizon (to last survivor at age ${esc(S.assumptions.planAge)})</td><td class="n">${k.H} yrs</td></tr></tbody></table></div>
    <p class="note">Method: human capital is the survival-weighted present value of after-tax earnings to retirement, discounted at the gilt rate plus an income-stability premium. Pension rights, including a spouse's pension from defined benefit schemes, and benefits such as ESA are discounted at the gilt rate. Spending and goals grow with inflation and are discounted at the gilt rate. Rental income is excluded because the property value already captures it. Joint items are split equally between the adults.</p></div>`;
  return h;
}
function renderTax(){
  const C=E.compute();const a=S.assumptions;let h=`<div class="sec-head"><div><h2>Tax and allowances</h2><p>Indicative 2026/27 position for each person, using rest-of-UK bands. Use it to spot unused allowances and cliff edges, not to file a return.</p></div></div>`+bannerHTML();
  const ad=S.members.filter(isAdult);const kids=S.members.filter(m=>m.role==='child');
  if(!ad.length)return h+`<div class="empty">Add at least one adult under People.</div>`;
  const row=(l,f,cls='n')=>`<tr><td>${l}</td>${ad.map(m=>`<td class="${cls}">${f(C.tax[m.ref],m)}</td>`).join('')}</tr>`;
  const head=`<tr><th></th>${ad.map(m=>`<th class="n">${esc(memberName(m.ref))}</th>`).join('')}</tr>`;
  h+=`<div class="panel"><h3>Income tax and National Insurance</h3><div class="tbl-wrap"><table><thead>${head}</thead><tbody>
    ${row('Employment income',t=>gbp(t.emp))}${row('Self-employment profit',t=>gbp(t.self))}${row('Dividends (incl. GIA yield)',t=>gbp(t.div))}${row('Savings interest (estimated)',t=>gbp(t.sav))}${row('Other taxable income',t=>gbp(t.nonSavOther))}
    ${row('Adjusted net income',t=>gbp(t.ani))}${row('Personal allowance',t=>gbp(t.pa))}${row('Income tax',t=>gbp(t.tax))}${row('National Insurance',t=>gbp(t.ni))}
    ${row('Top band',t=>t.band,'')}${row('Marginal rate on next £',t=>`<span class="pill ${t.marginal>=0.55?'bad':t.marginal>=0.4?'warn':'neu'}">${pct(t.marginal,0)}</span>`)}
    </tbody></table></div></div>`;
  h+=`<div class="panel"><h3>Allowances used this tax year</h3><div class="tbl-wrap"><table><thead>${head}</thead><tbody>
    ${row('ISA subscriptions',t=>`${gbp(t.isaUsed)} of ${gbp(N(a.isa))}`)}${row('ISA headroom',t=>`<b>${gbp(Math.max(0,N(a.isa)-t.isaUsed))}</b>`)}
    ${row('Lifetime ISA',t=>`${gbp(t.lisaUsed)} of ${gbp(N(a.lisa))}`)}
    ${row('Pension contributions (incl. employer)',t=>gbp(t.penUsed))}${row('Annual allowance available',t=>`${gbp(t.aa)}${t.tapered?' <span class="pill warn">tapered</span>':''}`)}${row('Pension headroom (before carry forward)',t=>`<b>${gbp(t.aa-t.penUsed)}</b>`)}
    ${row('Unrealised gains in GIA, shares, crypto',t=>gbp(t.unreal))}${row('CGT annual exempt amount',()=>gbp(N(a.cgtAE)))}${row('Dividend allowance',()=>gbp(N(a.divAll)))}
    </tbody></table></div>
    ${kids.length?`<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Child</th><th class="n">Junior ISA paid in</th><th class="n">Headroom</th></tr></thead><tbody>${kids.map(m=>`<tr><td>${esc(memberName(m.ref))}</td><td class="n">${gbp(C.tax[m.ref].jisaUsed)}</td><td class="n">${gbp(Math.max(0,N(a.jisa)-C.tax[m.ref].jisaUsed))}</td></tr>`).join('')}</tbody></table></div>`:''}</div>`;
  const obs=[];
  for(const m of ad){const t=C.tax[m.ref];const n=esc(memberName(m.ref));
    if(t.ani>N(a.paTaper)&&t.ani<N(a.arl))obs.push(['warn',`${n} is in the personal allowance taper (adjusted net income ${gbp(t.ani)}). A further pension contribution of up to ${gbp(t.ani-N(a.paTaper))} gets an effective 60% relief.`]);
    if(t.ani>N(a.hicbc)&&kids.some(k=>(E.ageOf(k)??99)<16))obs.push(['warn',`${n}: adjusted net income above ${gbp(N(a.hicbc))}. The High Income Child Benefit Charge applies if child benefit is claimed.`]);
    if(t.tapered)obs.push(['warn',`${n}: pension annual allowance is tapered to ${gbp(t.aa)}.`]);
    if(t.penUsed>t.aa)obs.push(['bad',`${n}: contributions of ${gbp(t.penUsed)} exceed the available allowance. Check carry forward from the last three years.`]);
    if(t.ras+t.netpay>t.emp+t.self+t.div&&t.ras+t.netpay>3600)obs.push(['bad',`${n}: personal contributions exceed relevant UK earnings, so tax relief is restricted.`]);
    if(t.isaUsed<N(a.isa)&&m.residence!=='nonuk')obs.push(['neu',`${n}: ${gbp(N(a.isa)-t.isaUsed)} of ISA allowance unused this year.`]);
    if(t.unreal>N(a.cgtAE))obs.push(['neu',`${n}: consider realising up to ${gbp(N(a.cgtAE))} of gains this year, or moving GIA holdings into the ISA.`]);
    if(yes(m.flexAccessed))obs.push(['warn',`${n}: Money Purchase Annual Allowance applies.`]);
    obs.push(['neu',`${n}: ${N(m.ukYears)>=10?'long-term UK resident, so worldwide assets fall within IHT':'not a long-term UK resident, so only UK assets fall within IHT'}.`]);}
  h+=`<div class="panel"><h3>Observations</h3><ul class="list">${obs.map(([l,t])=>`<li><span class="pill ${l}">${l==='bad'?'Action':l==='warn'?'Review':'Note'}</span><span class="grow">${t}</span></li>`).join('')}</ul>
    <p class="note">Not modelled: Scottish bands, carry forward, salary-sacrifice adjustments to threshold income, and DB accrual against the annual allowance.</p></div>`;
  return h;
}
function renderRisk(){
  const C=E.compute();const R=E.riskProfile(C);const k=C.kpi;const a=S.assumptions;
  const cls=x=>x==='Above average'?'good':x==='Below average'?'bad':'warn';
  let h=`<div class="sec-head"><div><h2>Risk profile and IPS</h2><p>Ability to take risk comes from the balance sheet. Willingness comes from the client. The CFA approach adopts the lower of the two and treats any gap as a conversation.</p></div></div>`+bannerHTML();
  h+=`<div class="kpis">
   <div class="kpi"><div class="k">Ability to take risk</div><div class="v t">${R.ability}</div><div class="s"><span class="pill ${cls(R.ability)}">score ${R.abilityScore>0?'+':''}${R.abilityScore}</span></div></div>
   <div class="kpi"><div class="k">Willingness to take risk</div><div class="v t">${R.willingness}</div><div class="s">Average ${R.willAvg.toFixed(1)} of 7 after loss reaction</div></div>
   <div class="kpi"><div class="k">Overall risk tolerance</div><div class="v t">${R.overall}</div><div class="s"><span class="pill ${cls(R.overall)}">use for asset allocation</span></div></div>
   <div class="kpi"><div class="k">Equity exposure incl. human capital</div><div class="v">${pct(k.totalEqPct)}</div><div class="s">Portfolio ${pct(k.finEqPct)} · earnings ${pct(k.hcEqPct)} equity-like</div></div></div>`;
  h+=`<div class="panel"><h3>Ability factors</h3><div class="tbl-wrap"><table><thead><tr><th>Factor</th><th>Evidence</th><th class="n">Points</th></tr></thead><tbody>${R.f.map(x=>`<tr><td>${esc(x.label)}</td><td>${esc(x.why)}</td><td class="n">${x.pts>0?'+':''}${x.pts}</td></tr>`).join('')}</tbody></table></div>`;
  if(R.ability!==R.willingness){const low={'Below average':0,'Average':1,'Above average':2};const willLower=low[R.willingness]<low[R.ability];
    h+=`<p class="note"><b>${willLower?'Willingness is below ability.':'Willingness exceeds ability.'}</b> ${willLower?'Explain the cost of holding less risk than the plan can bear before deciding.':'Recommend the lower level and record why.'} Record the rationale under Onboarding and compliance.</p>`}
  if(R.will.length>1&&Math.max(...R.will)-Math.min(...R.will)>=2)h+=`<p class="note"><b>Partners differ.</b> Risk scores range from ${Math.min(...R.will)} to ${Math.max(...R.will)}. Consider separate portfolios for each person's own wrappers.</p>`;
  h+=`</div>`;
  const ad=C.adl.filter(isAdult);const ret=ad.map(m=>({n:memberName(m.ref),y:Math.max(0,(N(m.retireAge)||65)-(C.derived[m.ref].age||0))})).sort((x,y)=>x.y-y.y);
  const near=S.goals.filter(g=>N(g.inYears)<=3).reduce((s,g)=>s+N(g.amount),0)+S.expenses.filter(e=>e.cat==='education'&&N(e.startIn)<=0).reduce((s,e)=>s+N(e.amount)*Math.min(3,has(e.duration)?N(e.duration):3),0);
  const fin=k.finAssets||1;const emp=S.accounts.filter(x=>x.wrapper==='Employer shares / options').reduce((s,x)=>s+N(x.value),0);
  const prot=ad.map(m=>{const hc=C.derived[m.ref].hc;const cover=S.protection.filter(p=>p.owner===m.ref&&/Life|Death|Family/.test(p.type)).reduce((s,p)=>s+N(p.sum),0);return {n:memberName(m.ref),hc,cover,gap:hc-cover}});
  const flags=[];if(!yes(S.household.willsInPlace))flags.push('no wills');if(!yes(S.household.lpaInPlace))flags.push('no lasting powers of attorney');ad.forEach(m=>{if(yes(m.usPerson))flags.push(memberName(m.ref)+' is a US person');if(m.residence!=='uk')flags.push(memberName(m.ref)+' is not UK resident')});
  const vul=ad.filter(m=>m.vulnerability&&m.vulnerability!=='None identified').map(m=>`${memberName(m.ref)} (${m.vulnerability})`);
  h+=`<div class="ips">
    <div class="panel"><h3>Return objective</h3><p>Grow assets to fund ${gbpK(C.tot.HH.cons)} of lifetime spending and ${gbpK(C.tot.HH.goal)} of goals and legacy, in present-value terms.</p><p class="muted">The funded ratio of ${isFinite(k.funded)?k.funded.toFixed(2):'n/a'}× means the plan ${k.funded>=1.2?'does not need to take extra risk to succeed; the surplus is discretionary':k.funded>=1?'is on track but has little margin for poor returns':'needs a higher return, more saving, later retirement or lower spending'}.</p></div>
    <div class="panel"><h3>Time horizon</h3><p>Multi-stage. Accumulation for about ${Math.round(ret[0]?.y||0)} years until ${esc(ret[0]?.n||'first retirement')} retires, then decumulation to year ${C.H}.</p><p class="muted">Life expectancy: ${ad.map(m=>`${esc(memberName(m.ref))} about ${Math.round((C.derived[m.ref].age||0)+(C.derived[m.ref].le||0))}`).join(', ')}. The plan runs to ${esc(a.planAge)}.</p></div>
    <div class="panel"><h3>Liquidity</h3><p>Hold ${gbpK(k.essential/2)} to ${gbpK(k.essential)} as an emergency reserve (6 to 12 months of essential spending). Cash today is ${gbpK(k.cashLiquid)}.</p><p class="muted">Known needs within 3 years: ${gbpK(near)}. Uncalled commitments: ${gbpK(k.uncalled)}.</p></div>
    <div class="panel"><h3>Taxes</h3><p>${ad.map(m=>`${esc(memberName(m.ref))}: ${C.tax[m.ref].band.toLowerCase()} rate, ${pct(C.tax[m.ref].marginal)} marginal`).join('. ')}.</p><p class="muted">Fill ISAs before GIAs, use pension relief at the highest marginal rate, and hold income-producing assets in wrappers. IHT estimate on second death: ${gbpK(k.iht)}.</p></div>
    <div class="panel"><h3>Legal and regulatory</h3><p>${flags.length?'Gaps: '+esc(flags.join('; '))+'.':'Wills and powers of attorney recorded; no residence or US issues.'}</p><p class="muted">Long-term residence status: ${ad.map(m=>`${esc(memberName(m.ref))} ${N(m.ukYears)>=10?'yes':'no'}`).join(', ')}.</p></div>
    <div class="panel"><h3>Unique circumstances</h3><p>${emp/fin>0.1?`Employer shares are ${pct(emp/fin)} of financial assets, above a 10% concentration limit. `:''}${vul.length?`Vulnerability noted for ${esc(vul.join(', '))}. `:''}${ad.some(m=>m.esg&&m.esg!=='None')?'Sustainability preferences recorded. ':''}${(emp/fin<=0.1&&!vul.length)?'No concentration or vulnerability issues recorded.':''}</p></div></div>`;
  h+=`<div class="panel"><h3>Mortality risk: human capital vs life cover</h3><div class="tbl-wrap"><table><thead><tr><th>Earner</th><th class="n">Human capital</th><th class="n">Life cover</th><th class="n">Gap</th></tr></thead><tbody>${prot.map(p=>`<tr><td>${esc(p.n)}</td><td class="n">${gbp(p.hc)}</td><td class="n">${gbp(p.cover)}</td><td class="n">${p.gap>0?`<span class="pill ${p.gap>p.hc*0.5?'bad':'warn'}">${gbp(p.gap)}</span>`:'<span class="pill good">covered</span>'}</td></tr>`).join('')}</tbody></table></div>
    <p class="note">Human-life-value view: the upper bound of cover needed to replace lost earnings. A needs-based review would subtract the earner's own consumption and add debts and goals.</p></div>`;
  return h;
}
function renderChecks(){const list=E.checks();
  let h=`<div class="sec-head"><div><h2>Data checks</h2><p>Completeness and consistency tests run on every change. Fix the items marked Action before relying on the outputs.</p></div></div>`+bannerHTML();
  h+=`<div class="panel"><ul class="list">${list.length?list.map(c=>`<li><span class="pill ${c.lvl==='bad'?'bad':'warn'}">${c.lvl==='bad'?'Action':'Review'}</span><span class="grow">${esc(c.msg)}</span><button class="btn" type="button" data-nav="${c.where}">Open</button></li>`).join(''):'<li><span class="pill good">Clear</span><span>No issues found.</span></li>'}</ul></div>`;return h}

const STAGE_TEXT={done:'Complete',open:'Needs work',current:'Ready',waiting:'Not started'};
function renderKyc(){
  const O=E.onboarding();const c=S.compliance;
  const ratingCls={Low:'good',Medium:'warn',High:'bad',Prohibited:'bad'}[O.rating];
  const stageCls=/Approved$|Approved with conditions/.test(O.stage)?'good':/Declined|Prohibited|open issues/.test(O.stage)?'bad':O.stage==='Ready for review'?'good':'warn';
  let h=`<div class="sec-head"><div><h2>KYC and onboarding status</h2><p>Customer due diligence, AML risk rating, suitability, disclosures and the four-eyes sign-off, worked out from what is recorded. Screening results are entered by hand; connect a screening provider for live checks.</p></div><div class="addrow"><button class="btn" type="button" data-nav="compliance">Edit onboarding details</button></div></div>`+bannerHTML();
  h+=`<div class="stages" role="list">${O.progress.map(p=>`<div class="stage" role="listitem" data-s="${p.status}"><b>${esc(p.label)}</b><span>${p.count?p.count+' to fix':STAGE_TEXT[p.status]}</span></div>`).join('')}</div>`;
  h+=`<div class="kpis">
    <div class="kpi"><div class="k">Status</div><div class="v t">${esc(O.stage)}</div><div class="s"><span class="pill ${stageCls}">${O.blockerCount} blockers · ${O.warnCount} to review</span></div></div>
    <div class="kpi"><div class="k">AML risk rating</div><div class="v t">${esc(O.rating)}</div><div class="s"><span class="pill ${ratingCls}">score ${O.score}${O.edd?' · EDD required':''}</span></div></div>
    <div class="kpi"><div class="k">Ongoing review</div><div class="v t">Every ${O.reviewYears} year${O.reviewYears>1?'s':''}</div><div class="s">${O.nextReview?'Next review '+fmtDate(O.nextReview):'Set when the file is approved'}</div></div>
    <div class="kpi"><div class="k">Sign-off</div><div class="v t">${esc(optList(H.fieldsOf(SCHEMA.compliance).find(f=>f.k==='outcome').o).find(o=>o[0]===c.outcome)?.[1]||'Pending review')}</div><div class="s">${c.preparer?'Prepared by '+esc(c.preparer):'Preparer not recorded'}${c.reviewer?' · reviewed by '+esc(c.reviewer):''}</div></div></div>`;
  // Per-person CDD
  const lvlPill=l=>`<span class="pill ${l==='ok'?'good':l==='warn'?'warn':'bad'}">${l==='ok'?'Done':l==='warn'?'Review':'Missing'}</span>`;
  h+=`<div class="kyc-grid">${O.people.map(p=>`<div class="panel"><h3>${esc(p.name)} <span class="muted" style="font:500 12px var(--f-mono)">${esc(p.ref)}</span></h3><div class="tbl-wrap"><table><tbody>${p.checks.map(x=>`<tr><td>${esc(x.label)}</td><td>${esc(x.detail)}</td><td class="n">${lvlPill(x.lvl)}</td></tr>`).join('')}</tbody></table></div></div>`).join('')||'<div class="empty">Add adults under People to start KYC.</div>'}</div>`;
  // AML factors and docs
  h+=`<div class="two"><div class="panel"><h3>AML risk factors</h3>${O.factors.length?`<div class="tbl-wrap"><table><tbody>${O.factors.map(f=>`<tr><td>${esc(f.why)}${f.edd?' <span class="pill bad">EDD</span>':''}</td><td class="n">+${f.pts}</td></tr>`).join('')}<tr class="t"><td>Total</td><td class="n">${O.score}</td></tr></tbody></table></div>`:'<p class="muted">No higher-risk factors recorded.</p>'}
    <p class="note">0–1 points: low (review every 3 years). 2–3: medium (2 years). 4 or more, any PEP, or a high-risk third country: high, with enhanced due diligence and yearly review.</p></div>
    <div class="panel"><h3>Disclosures</h3><ul class="list">${O.docs.map(d=>`<li><span class="pill ${d.ok?'good':d.optional?'neu':'bad'}">${d.ok?'Done':d.optional?'Later':'Missing'}</span><span class="grow">${esc(d.label)}</span><span class="muted">${d.date?fmtDate(d.date):''}</span></li>`).join('')}</ul></div></div>`;
  // Open items grouped by stage
  const groups=[['discovery','Discovery'],['kyc','KYC and AML'],['suitability','Suitability'],['documents','Disclosures'],['signoff','Compliance review']];
  const any=O.items.length;
  h+=`<div class="panel"><h3>Open items</h3>${any?groups.map(([k,l])=>{const its=O.items.filter(i=>i.stage===k);if(!its.length)return '';return `<h4 style="margin:12px 0 4px;font:600 11px/1 var(--f-body);letter-spacing:.09em;text-transform:uppercase;color:var(--muted)">${l}</h4><ul class="list">${its.map(i=>`<li><span class="pill ${i.lvl==='bad'?'bad':'warn'}">${i.lvl==='bad'?'Blocker':'Review'}</span><span class="grow">${esc(i.msg)}</span><button class="btn" type="button" data-nav="${esc(i.where)}">Open</button></li>`).join('')}</ul>`}).join(''):'<p><span class="pill good">Clear</span> Nothing outstanding.</p>'}
    <p class="note">These rules are a starting framework based on the Money Laundering Regulations 2017, JMLSG guidance, FCA COBS and the Consumer Duty. Align thresholds with your firm's own risk assessment before use.</p></div>`;
  return h;
}
async function renderAudit(){
  let h=`<div class="sec-head"><div><h2>Audit trail</h2><p>${Store.mode==='server'?'Every saved change, recorded by the server with the signed-in user and time. Entries cannot be edited from this screen.':'Changes made in this browser. Run the server version for a tamper-resistant trail with named logins.'}</p></div></div>`+bannerHTML();
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let rows=[];try{rows=await Store.audit()}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>Could not load the audit trail. ${esc(e.message)}</div></div>`;return}
  if(VIEW!=='audit')return;
  const lab=p=>{const m=/^(\w+)(?:\[(\d+)\])?\.(\w+)$/.exec(p);if(!m)return p;const [,sec,i,k]=m;const s=SCHEMA[sec];if(!s)return p;if(k==='count')return `${s.title}: number of records`;const f=fieldsOf(s).find(x=>x.k===k);return `${s.title}${i!==undefined?' #'+(+i+1):''}: ${f?f.l:k}`};
  h+=`<div class="panel">${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th><th>To</th></tr></thead><tbody>${rows.slice(0,1000).map(r=>`<tr><td style="white-space:nowrap">${esc(fmtTs(r.ts))}</td><td>${esc(r.user)}</td><td>${esc(r.field==='created'?'Household created':r.field==='import'?'Imported a file':lab(r.field))}</td><td class="mono">${esc(r.from)}</td><td class="mono">${esc(r.to)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No changes recorded yet.</p>'}</div>`;
  $('#main').innerHTML=h;
}
async function renderClients(){
  let h=`<div class="sec-head"><div><h2>Households</h2><p>Signed in as ${esc(Store.user)}. ${Store.encrypted?'Client files are encrypted at rest.':'<b>Encryption at rest is off.</b> Set DATA_KEY on the server.'}</p></div><div class="addrow"><button class="btn" type="button" data-act="newSample">New from sample</button><button class="btn primary" type="button" data-act="newBlank">New household</button></div></div>`;
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.list()}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>Could not load households. ${esc(e.message)}</div></div>`;return}
  if(VIEW!=='clients')return;
  const rc={Low:'good',Medium:'warn',High:'bad',Prohibited:'bad'};
  h+=`<div class="panel">${list.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Household</th><th>Status</th><th>AML</th><th>Next due</th><th>Last change</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${esc(x.name||'Unnamed')}</b><br><span class="muted">${esc(x.reference||'')}</span></td><td>${esc(x.stage)}${x.blockers?` <span class="pill bad">${x.blockers}</span>`:''}</td><td><span class="pill ${rc[x.rating]||'neu'}">${esc(x.rating)}</span></td><td>${x.due?fmtDate(x.due):'–'}${x.overdue?` <span class="pill bad">${x.overdue} overdue</span>`:''}</td><td>${esc(fmtTs(x.updatedAt))}<br><span class="muted">${esc(x.updatedBy||'')}</span></td><td><button class="btn" type="button" data-act="openHousehold" data-id="${esc(x.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No households yet. Create one to start onboarding.</div>'}</div>`;
  $('#main').innerHTML=h;
}

async function renderTeam(){
  let h=`<div class="sec-head"><div><h2>Team</h2><p>People at ${esc(Store.firmName)} who can sign in. Each person needs their own login so the audit trail shows who did what. Deactivating someone signs them out at once; their past entries stay in the audit trail.</p></div></div>`+bannerHTML(false);
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.api('GET','members')}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(VIEW!=='team')return;
  const used=list.filter(x=>x.active).length;
  h+=`<div class="panel"><h3>Invite someone</h3><p class="muted">${used} of ${Store.seats} seats in use. They get an email link to choose a password and set up two-step verification.</p>
    <div class="fields"><div class="f"><label for="invName">Name</label><input id="invName" autocomplete="off"></div><div class="f"><label for="invEmail">Email</label><input id="invEmail" type="email" autocomplete="off"></div>
    <div class="f"><label for="invRole">Role</label><select id="invRole"><option value="adviser">Adviser: works on client files</option><option value="admin">Administrator: also manages the team</option></select></div></div>
    <div class="addrow"><button class="btn primary" type="button" data-act="invite"${used>=Store.seats?' disabled':''}>Send invitation</button></div></div>`;
  h+=`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${x.role==='admin'?'Administrator':'Adviser'}</td><td><span class="pill ${x.active?'good':'neu'}">${x.active?'Active':'Deactivated'}</span></td><td>${x.email===Store.email?'<span class="muted">You</span>':`<button class="btn" type="button" data-act="memberActive" data-uid="${esc(x.userId)}" data-on="${x.active?'0':'1'}">${x.active?'Deactivate':'Reactivate'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#main').innerHTML=h;
}

function renderGuide(){
  const a=S.assumptions;const C=E.compute();const k=C.kpi;
  const sec=(id,t,body)=>`<div class="panel" id="g-${id}"><h3>${t}</h3>${body}</div>`;
  const toc=[['flow','Workflow'],['ebs','Economic balance sheet'],['hc','Human capital'],['liab','Liabilities side'],['ratios','Reading the ratios'],['tax','Tax'],['iht','Inheritance tax'],['risk','Risk profile'],['aml','KYC and AML'],['limits','Limits']];
  let h=`<div class="sec-head"><div><h2>How the model works</h2><p>The framework behind every figure and status in this file, written for analysts and compliance staff. Hover the <span class="tip" aria-hidden="true">i</span> next to any field for how that input is used.</p></div></div>`;
  h+=`<div class="guide"><div class="toc">${toc.map(([id,t])=>`<a href="#g-${id}">${t}</a>`).join('')}</div>`;
  h+=sec('flow','Workflow',`<div class="flow"><span>Discovery</span><i>→</i><span>KYC and AML</span><i>→</i><span>Suitability</span><i>→</i><span>Disclosures</span><i>→</i><span>Compliance review</span><i>→</i><span>Decision</span></div>
    <p>Client data is entered once under <b>Client data</b>. The outputs are recalculated from it on every change: nothing is typed into the balance sheet or the KYC status directly. The onboarding status is the first stage that still has a blocker; once there are none the file is <b>Ready for review</b>, and the reviewer’s outcome sets the decision and the next review date.</p>
    <p>Every save creates a version and an audit entry (who changed which field, from what, to what). Records are never deleted, in line with the 5-year retention rule in the Money Laundering Regulations.</p>`);
  h+=sec('ebs','Economic balance sheet (CFA private wealth framework)',`<p>A conventional net worth statement counts only what can be sold today. The economic balance sheet adds the present value of what the household <i>will</i> earn and receive, and of what it has <i>committed</i> to spend, so that the two sides can be compared on the same footing.</p>
    <div class="formula">Assets      = financial capital + real assets + human capital + pension and income rights<br>Liabilities = debt + PV(spending to plan age) + PV(goals and legacy) + deferred tax<br>Economic net worth = Assets − Liabilities &nbsp;&nbsp;·&nbsp;&nbsp; Funded ratio = Assets ÷ Liabilities</div>
    <p>All present values use the gilt rate (${a.rf}% in Assumptions) and are in today’s money. Every future amount for a person is multiplied by the probability that they are alive to earn or spend it, so the model needs date of birth, sex, health and smoking for each adult.</p>
    <p>For this household: assets ${gbpK(C.tot.HH.A)}, liabilities ${gbpK(C.tot.HH.L)}, economic net worth ${gbpK(k.econNW)}. Traditional net worth (market assets less debt) is ${gbpK(k.tradNW)}.</p>`);
  h+=sec('hc','Human capital',`<p>Human capital is the value today of future earnings. For each earner, each year’s pay to retirement age is grown at its growth rate, reduced to after-tax using the Tax view’s marginal rates, multiplied by the probability of survival to that year, and discounted.</p>
    <div class="formula">HC = Σ<sub>t</sub> pay<sub>t</sub> × (1 − tax rate) × P(alive at t) ÷ (1 + gilt rate + premium)<sup>t</sup></div>
    <p>The <b>premium</b> depends on income stability (very stable ${a.pLow}%, stable ${a.pMed}%, variable ${a.pHigh}%, volatile ${a.pVhigh}%). Volatile earnings are worth less today and are treated as more equity-like when the risk view measures total equity exposure, because a founder’s pay already behaves like a share portfolio.</p>
    <p>Pensions in payment, annuities, State Pension and benefits such as ESA are <b>income rights</b>: the same survival-weighted present value, but discounted at the gilt rate alone because they do not depend on employment.</p>
    <h4>Mortality</h4><p>Survival follows a Gompertz curve with a modal age at death of ${a.gM} (men) and ${a.gF} (women) and dispersion ${a.gB} years. Smoking takes 6 years off the modal age, impaired health 5, a serious condition 12; excellent health adds 1.5.</p>`);
  h+=sec('liab','Liabilities side',`<ul><li><b>Debt</b>: outstanding balances as recorded.</li>
    <li><b>Spending</b>: each line is inflated at its own rate (or CPI, ${a.cpi}%) and discounted at the gilt rate for every year it runs, with payments assumed at the start of each year (the prudent choice). Essential lines are weighted by survival when that option is on.</li>
    <li><b>Goals and legacy</b>: one-off amounts inflated to their date and discounted back. The legacy target is treated as a goal at second death.</li>
    <li><b>Deferred tax</b>: income tax on pension pots above the tax-free lump sum at the expected retirement rate; CGT on gains above base cost in taxable accounts and investment property; tax on bond gains.</li></ul>`);
  h+=sec('ratios','Reading the ratios',`<table><thead><tr><th>Measure</th><th>Meaning</th><th>Reading</th></tr></thead><tbody>
    <tr><td>Funded ratio</td><td>All economic assets ÷ all liabilities</td><td>≥ 1.2 surplus · 1.0–1.2 tight · &lt; 1.0 shortfall: the plan is not fully funded on these assumptions</td></tr>
    <tr><td>Core funded ratio</td><td>Assets ÷ (debt + essential spending + deferred tax)</td><td>Whether the non-negotiables are covered even if wants and wishes are dropped</td></tr>
    <tr><td>Human capital share</td><td>Human capital ÷ economic assets</td><td>High share = the household depends on future earnings; protection and earnings risk matter more than portfolio risk</td></tr>
    <tr><td>Cash runway</td><td>Liquid cash ÷ monthly essential outgoings and debt service</td><td>Months the household can run without income</td></tr>
    <tr><td>Equity exposure incl. human capital</td><td>Equity-like assets (portfolio + equity-like earnings) ÷ (portfolio + human capital)</td><td>True risk position, compared with the risk tolerance</td></tr></tbody></table>`);
  h+=sec('tax','Tax and allowances',`<p>The Tax view runs each adult’s income through 2026/27 rest-of-UK income tax and National Insurance: personal allowance (tapered above £${Number(a.paTaper).toLocaleString('en-GB')}), basic, higher and additional rate bands, separate dividend rates and the dividend allowance, savings allowance and starting rate for savings, employee or Class 4 NI, and the child benefit charge. Pension contributions are grossed up according to the relief method.</p>
    <p>Allowance checks compare contributions this tax year with the ISA, Junior ISA and pension annual allowances (including the taper for high earners and the MPAA where flagged). The purpose is to spot unused allowances and cliff edges, not to prepare a return.</p>`);
  h+=sec('iht','Inheritance tax on second death',`<div class="formula">Estate = financial assets (excluding pensions until Apr 2027) + real assets − debt − Business Relief assets − child wrappers + life cover not in trust<br>Bands  = nil-rate band × 2 if married − gifts in last 7 years, plus residence band (capped at the home’s net value, tapered above £${Number(a.rnrbTaper).toLocaleString('en-GB')})<br>IHT    = max(0, Estate − Bands) × ${a.ihtRate}%</div>
    <p>The estimate assumes everything passes to the surviving spouse first (no tax on first death) and to direct descendants on second death, so the residence band applies only when there are children. Tick <i>Include pensions in estate</i> under Assumptions to see the position from April 2027.</p>`);
  h+=sec('risk','Risk profile',`<h4>Ability to take risk</h4><p>Scored from the balance sheet, not from opinion: funded status (+2 to −2), time horizon to plan age (+1 to −1), liquidity in months (+1 to −1), earnings stability (+1 to −1), leverage (−1 if debt exceeds half of financial assets) and the adviser’s capacity-for-loss view (+1 to −1). A total of 3 or more is <b>above average</b>, −1 or less <b>below average</b>.</p>
    <h4>Willingness to take risk</h4><p>Each adult’s risk tolerance (1–7) is adjusted for their stated reaction to a 25% fall (sell all −2, sell some −1, hold 0, buy more +1). The household average of 5 or more is above average; under 3.5 below average.</p>
    <h4>Overall</h4><p>The lower of ability and willingness, which is the usual regulatory expectation. When the two differ the Compliance section requires a written rationale for the agreed level, and the IPS records both.</p>`);
  h+=sec('aml','KYC and AML rules',`<h4>Customer due diligence (each adult)</h4><p>Personal details, NI number format, photo ID that has not expired, proof of address and sanctions, PEP and adverse media screening dated within 3 months, PEP status, source of wealth, and CRS/FATCA self-certification with tax IDs for any non-UK residence. Each gap is a blocker at the KYC stage.</p>
    <h4>AML risk score</h4><table><thead><tr><th>Factor</th><th>Points</th></tr></thead><tbody><tr><td>Politically exposed person, or links to a high-risk third country</td><td>Always High</td></tr><tr><td>Third-party payment of funds</td><td>2</td></tr><tr><td>Confirmed adverse media</td><td>2</td></tr><tr><td>Client not met face to face</td><td>1</td></tr><tr><td>Funds from a non-UK bank account</td><td>1</td></tr><tr><td>Trusts, companies or offshore structures</td><td>1–2</td></tr><tr><td>Cash-intensive business or wealth</td><td>1</td></tr><tr><td>Large expected investment relative to the source of wealth</td><td>1</td></tr></tbody></table>
    <p>0–1 points is <b>Low</b> (review every 3 years), 2–3 <b>Medium</b> (2 years), 4 or more <b>High</b> (yearly). High requires enhanced due diligence: EDD findings and a verified source of wealth, and for PEPs, named senior management approval. A confirmed sanctions match is <b>Prohibited</b>.</p>
    <h4>Suitability and disclosures</h4><p>Risk attitude, loss reaction, knowledge and experience, capacity for loss, objectives and the target market check are required. Client agreement, fee agreement, ex-ante costs and the privacy notice are blockers until recorded. The reviewer must differ from the preparer.</p>
    <p class="note">These rules are a starting framework from MLR 2017, JMLSG guidance, FCA COBS and the Consumer Duty. The firm’s MLRO must adapt them to its own risk assessment before use.</p>`);
  h+=sec('limits','What the model does not do',`<ul><li>Scottish income tax bands and pension carry-forward are not modelled.</li><li>Screening results are entered by hand; no sanctions, PEP or electronic ID provider is called.</li><li>Investment returns are not projected: the balance sheet values everything at the risk-free rate, which is deliberate for a funding view but means it is not a cash-flow forecast.</li><li>Tax figures are indicative and must be checked against HMRC for the year in question.</li></ul>`);
  return h+'</div>';
}

const REVIEW_CLS={overdue:'bad',soon:'warn',later:'neu'};
const LOSS_LABEL={sellall:'Sell everything (−2)',sellsome:'Sell some (−1)',hold:'Hold (0)',buy:'Invest more (+1)'};
function rtqPanel(){const ad=S.members.filter(isAdult);if(!ad.length)return '<div class="empty">Add the adults under People first.</div>';
  let h='<div class="rtq-grid">';
  for(const m of ad){const q=S.rtq.find(x=>x.owner===m.ref);const nm=memberName(m.ref);
    if(!q){h+=`<div class="panel"><h3>${esc(nm)}</h3><p class="muted">No questionnaire yet.</p><button class="btn primary" type="button" data-act="rtqStart" data-ref="${esc(m.ref)}">Start questionnaire</button></div>`;continue}
    const sc=H.rtqScore(q);const res=H.rtqResult(q);
    const row=(l,a,of,tot,out)=>`<tr><td>${l}</td><td class="n">${a}/${of}</td><td class="n">${tot}</td><td><b>${out}</b></td></tr>`;
    h+=`<div class="panel"><h3>${esc(nm)} <span class="pill ${sc.complete?'good':'warn'}">${sc.complete?'Complete':sc.answered+' of '+sc.of+' answered'}</span></h3>
      <div class="tbl-wrap"><table><thead><tr><th>Part</th><th class="n">Answered</th><th class="n">Score</th><th>Result</th></tr></thead><tbody>
      ${row('Attitude to risk',sc.atr.answered,sc.atr.of,sc.atr.total+' of 45',sc.atr.band?'Risk tolerance '+sc.atr.band:'–')}
      ${row('Reaction to a 25% fall',sc.loss?1:0,1,'',sc.loss?LOSS_LABEL[sc.loss]:'–')}
      ${row('Capacity for loss',sc.cfl.answered,sc.cfl.of,(sc.cfl.total>0?'+':'')+sc.cfl.total+' (−6 to +6)',sc.cfl.level?sc.cfl.level[0].toUpperCase()+sc.cfl.level.slice(1):'–')}
      ${row('Knowledge and experience',sc.ke.answered,sc.ke.of,sc.ke.total+' of 9',sc.ke.level||'–')}</tbody></table></div>
      ${res?`<p class="note">Applied to ${esc(nm)}’s record under People: risk tolerance ${res.riskTol}, loss reaction, capacity for loss ${res.capacity}, knowledge ${res.experience}. Willingness in the risk profile = ${res.riskTol} ${({sellall:'− 2',sellsome:'− 1',hold:'+ 0',buy:'+ 1'})[res.lossReaction]} for the loss reaction.</p>`:''}</div>`}
  h+='</div>';
  h+=`<details class="panel rtq-key"><summary><b>How the scores are worked out</b></summary>
    <h4>Attitude to risk</h4><p>Nine questions, each answer scored 1 (most cautious) to 5. The total, from 9 to 45, sets the risk tolerance:</p>
    <table><thead><tr><th>Total</th>${H.ATR_BANDS.map(([a,b])=>`<th class="n">${a}–${b}</th>`).join('')}</tr></thead><tbody><tr><td>Risk tolerance</td>${H.ATR_BANDS.map(([,,c])=>`<td class="n"><b>${c}</b></td>`).join('')}</tr></tbody></table>
    <p>The reaction to a 25% fall is asked separately and sets the loss reaction. The risk profile then adjusts willingness by −2, −1, 0 or +1, so the answer counts once.</p>
    <h4>Capacity for loss</h4><p>Six questions scored −1, 0 or +1. Total −2 or less: <b>low</b>; +2 or more: <b>high</b>; otherwise <b>medium</b>. This joins the balance-sheet measures (funded ratio, horizon, liquidity, earnings stability, leverage) in the ability-to-take-risk score.</p>
    <h4>Knowledge and experience</h4><p>Three questions scored 0 to 3. Total 0–1: <b>none</b>; 2–4: <b>basic</b>; 5–7: <b>informed</b>; 8–9: <b>advanced</b>.</p>
    <p class="note">The questions and bands are a starting framework. The firm should calibrate them against its own risk-profiling tool and keep a record of the version used.</p></details>`;
  return h}
let LOA_IDX=0;
const LOA_REQ=[['reqValue','the current value of the plan'],['reqTransfer','the current transfer value and any exit charges or penalties'],['reqFunds','the funds held, with unit holdings and prices'],['reqCharges','all charges: product, fund and any adviser charges currently paid'],['reqContrib','the contribution history, including employer contributions'],['reqGuarantees','any guarantees or safeguarded benefits, such as guaranteed annuity rates, guaranteed minimum pension or protected tax-free cash'],['reqDeath','the death benefits and any nomination of beneficiaries'],['reqRetire','the selected retirement date and the options available at retirement']];
function renderLetter(){const l=S.loas[LOA_IDX];if(!l)return '<div class="empty">Letter not found.</div>';const F=Store.firm.settings.firm;
  const prov=(Store.firm.settings.providers||[]).find(p=>p.name===l.provider)||{};const m=S.members.find(x=>x.ref===l.owner)||{};
  const nm=[m.title,m.firstName,m.lastName].filter(Boolean).join(' ');const nl=t=>esc(t||'').replace(/\n/g,'<br>');
  const req=LOA_REQ.filter(([k])=>yes(l[k])).map(([,t])=>t);if(has(l.otherRequest))req.push(l.otherRequest);
  const missing=[!F.name&&'firm name',!F.frn&&'FCA reference number',!F.address&&'firm address',!l.provider&&'provider',!prov.address&&!prov.email&&'provider address or email',!nm&&'client',!m.dob&&'client date of birth',!m.niNumber&&'client NI number',!m.address&&'client address'].filter(Boolean);
  let h=`<div class="sec-head no-print"><div><h2>Letter of authority</h2><p>Check the letter, then print it or save it as PDF. When the client has signed, set the status to Signed and record the date.</p></div><div class="addrow"><button class="btn" type="button" data-nav="loas">Back to letters</button><button class="btn primary" type="button" data-act="print">Print or save as PDF</button></div></div>`;
  if(missing.length)h+=`<div class="banner bad no-print"><div><b>Missing from the letter:</b> ${esc(missing.join(', '))}. Fill these in under Firm settings, the provider directory or People before sending.</div></div>`;
  h+=`<article class="letter">
    <header class="lh"><div><div class="lh-name">${esc(F.name||'Firm name')}</div><div class="lh-addr">${nl(F.address)}</div></div><div class="lh-meta">${F.phone?esc(F.phone)+'<br>':''}${F.email?esc(F.email)+'<br>':''}${F.website?esc(F.website)+'<br>':''}${F.frn?'FCA FRN '+esc(F.frn):''}</div></header>
    <div class="to">${esc(l.provider||'Provider')}<br>${nl(prov.address)}${!prov.address&&prov.email?esc(prov.email):''}</div>
    <p class="date">${fmtDate(H.today())}</p>
    <p class="re"><b>Letter of authority</b><br>Client: ${esc(nm||'—')}${m.dob?' · Date of birth '+fmtDate(m.dob):''}${m.niNumber?' · NI number '+esc(m.niNumber):''}<br>Address: ${nl((m.address||'').replace(/\n/g,', '))}${m.postcode?' '+esc(m.postcode):''}<br>Plan: ${esc(l.planType||'')}${l.policyRef?' · Policy number '+esc(l.policyRef):' · all plans held in my name'}${l.employer?' · Employer '+esc(l.employer):''}</p>
    <p>I authorise ${esc(F.name||'the firm named above')}${F.frn?' (FCA firm reference number '+esc(F.frn)+')':''} to request and receive information about ${l.policyRef?'the plan above':'any plans I hold with you'}, and to discuss ${l.policyRef?'it':'them'} with you on my behalf.</p>
    ${req.length?`<p>Please send the following information to ${esc(F.name||'the firm')}${F.email?' at '+esc(F.email):''}${F.address?', or by post to the address above':''}:</p><ul>${req.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}
    <p>This authority lets the firm receive information only. It does not allow the firm to make changes, transactions or withdrawals. Please continue to send statements and correspondence to me as usual. This authority remains in force until I withdraw it in writing. A copy of this letter is as valid as the original.</p>
    <p>I consent to you sharing my personal data with ${esc(F.name||'the firm')} for this purpose.</p>
    <div class="sig"><div><div class="line"></div>Signature of ${esc(nm||'client')}</div><div><div class="line"></div>Date</div></div>
    <p class="cc">Prepared by ${esc(F.signatory||Store.user||'')}${F.name?', '+esc(F.name):''}. ${esc(F.name||'The firm')} is authorised and regulated by the Financial Conduct Authority.</p>
  </article>`;
  return h}
function firmCards(key){const s=SCHEMA[key];const L=Store.firm.settings[key];
  let h=`<div class="sec-head" style="margin-top:28px"><div><h2 style="font-size:20px">${esc(s.title)}</h2><p>${esc(s.desc)}</p></div><div class="addrow"><button class="btn" type="button" data-act="toggleAll" data-col="${key}">Expand all</button><button class="btn primary" type="button" data-act="add" data-col="${key}">Add ${esc(s.item)}</button></div></div>`;
  if(!L.length)h+=`<div class="empty">None yet.</div>`;
  L.forEach((r,i)=>{const [t,meta,v]=summary(key,r);const open=OPEN.has(key+':'+i);
    h+=`<div class="card" data-open="${open}" data-card="${key}:${i}"><div class="card-h" data-act="toggle" data-col="${key}" data-idx="${i}" role="button" tabindex="0" aria-expanded="${open}"><span class="chev">▸</span><span class="sum"><b>${esc(t)}</b><span class="meta">${esc(meta)}</span></span><span class="val">${esc(v)}</span><button class="btn ghost" type="button" data-act="del" data-col="${key}" data-idx="${i}">Remove</button></div><div class="card-b">${fieldsBlock(key,i,r)}</div></div>`});
  return h}
function renderFirmSettings(){const F=Store.firm.settings;
  let h=`<div class="sec-head"><div><h2>Firm settings</h2><p>Shared by every household: the firm\u2019s details for letters, the team that tasks are assigned to, and the providers letters of authority go to.${Store.mode==='server'?' Changes are saved for everyone and recorded in the firm audit trail.':' Saved in this browser only.'}</p></div></div>`+bannerHTML(false);
  h+=`<div class="card" data-open="true"><div class="card-b" style="border-top:0">${fieldsBlock('firm',0,F.firm)}</div></div>`;
  return h+firmCards('team')+firmCards('providers')}
const TASKF={who:'',status:'open'};
async function renderTasks(){
  let h=`<div class="sec-head"><div><h2>Tasks</h2><p>Every task across the firm\u2019s households. Assign and update tasks inside each household under Relationship › Tasks.</p></div></div>`;
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let rows=[];
  try{if(Store.mode==='server'){const list=await Store.list();for(const x of list)for(const t of (x.tasks||[]))rows.push({...t,hh:x.name||'Unnamed',id:x.id})}
    else for(const t of H.openTasks(S))rows.push({...t,hh:S.household.name||'This household',id:''})}
  catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(VIEW!=='tasks')return;
  const t=H.today();const people=[...new Set(rows.map(r=>r.owner||'Unassigned'))].sort();
  const shown=rows.filter(r=>!TASKF.who||(r.owner||'Unassigned')===TASKF.who).sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')||({High:0,Normal:1,Low:2}[a.priority]-{High:0,Normal:1,Low:2}[b.priority]));
  const byWho=people.map(p=>({p,n:rows.filter(r=>(r.owner||'Unassigned')===p).length,od:rows.filter(r=>(r.owner||'Unassigned')===p&&r.due&&r.due<t).length}));
  h+=`<div class="kpis">${byWho.map(x=>`<button type="button" class="kpi kpi-btn${TASKF.who===x.p?' sel':''}" data-act="taskFilter" data-k="who" data-v="${TASKF.who===x.p?'':esc(x.p)}"><div class="k">${esc(x.p)}</div><div class="v">${x.n}</div><div class="s">${x.od?`<span class="pill bad">${x.od} overdue</span>`:'open tasks'}</div></button>`).join('')||'<div class="kpi"><div class="k">Open tasks</div><div class="v">0</div></div>'}</div>`;
  h+=`<div class="panel">${shown.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Due</th><th>Task</th><th>Household</th><th>Assigned to</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${shown.map(r=>{const od=r.due&&r.due<t;return `<tr><td style="white-space:nowrap">${r.due?fmtDate(r.due):'–'}${od?' <span class="pill bad">overdue</span>':''}</td><td><b>${esc(r.description||'Task')}</b></td><td>${esc(r.hh)}</td><td>${esc(r.owner||'Unassigned')}</td><td>${r.priority==='High'?'<span class="pill bad">High</span>':esc(r.priority)}</td><td>${esc(r.status)}</td><td>${r.id?`<button class="btn" type="button" data-act="openHousehold" data-id="${esc(r.id)}" data-view="actions">Open</button>`:`<button class="btn" type="button" data-nav="actions">Open</button>`}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty">No open tasks'+(TASKF.who?' for '+esc(TASKF.who):'')+'.</div>'}</div>`;
  $('#main').innerHTML=h;
}
function renderDrift(){
  const M=E.mandateCheck();const S_=S.mandate;const scls={'In line':'good',Drift:'warn',Incomplete:'bad'}[M.status];
  let h=`<div class="sec-head"><div><h2>Mandate check</h2><p>The agreed mandate against the risk profile and the current accounts. Targets come from the model portfolio; the current split is value-weighted across every account under Savings and investments.</p></div><div class="addrow"><button class="btn" type="button" data-nav="mandate">Edit mandate</button></div></div>`+bannerHTML(false);
  h+=`<div class="kpis">
    <div class="kpi"><div class="k">Model portfolio</div><div class="v t">${esc(M.model?M.model.name:'None chosen')}</div><div class="s">${esc(M.benchmark||'')}</div></div>
    <div class="kpi"><div class="k">Agreed risk level</div><div class="v">${M.risk||'–'}</div><div class="s">Profile: ${esc(M.profile)} (${M.suggested[0]}–${M.suggested[1]})${M.model?` · model ${M.model.riskMin}–${M.model.riskMax}`:''}</div></div>
    <div class="kpi"><div class="k">Status</div><div class="v t">${M.status}</div><div class="s"><span class="pill ${scls}">${M.breaches?M.breaches+' class'+(M.breaches>1?'es':'')+' outside ±'+M.tol+' pts':M.model?'within ±'+M.tol+' pts':'set up the mandate'}</span></div></div>
    <div class="kpi"><div class="k">Next mandate review</div><div class="v t">${M.nextReview?fmtDate(M.nextReview):'–'}</div><div class="s">${S_.basis||''}${S_.rebalance?' · rebalance '+S_.rebalance.toLowerCase():''}</div></div></div>`;
  if(M.issues.length)h+=`<div class="panel"><h3>To resolve</h3><ul class="list">${M.issues.map(i=>`<li><span class="pill ${i.lvl==='bad'?'bad':'warn'}">${i.lvl==='bad'?'Blocker':'Review'}</span><span class="grow">${esc(i.msg)}</span>${i.where&&i.where!=='drift'?`<button class="btn" type="button" data-nav="${esc(i.where)}">Open</button>`:''}</li>`).join('')}</ul></div>`;
  h+=`<div class="two"><div class="panel"><h3>Allocation against target</h3>${M.invested?`<div class="tbl-wrap"><table><thead><tr><th>Asset class</th><th class="n">Target</th><th class="n">Current</th><th class="n">Difference</th><th></th></tr></thead><tbody>${M.classes.map(c=>`<tr><td>${esc(c.l)}</td><td class="n">${c.target.toFixed(0)}%</td><td class="n">${c.current.toFixed(0)}%</td><td class="n">${c.diff>0?'+':''}${c.diff.toFixed(1)}</td><td>${M.model?`<span class="pill ${c.breach?'warn':'good'}">${c.breach?'drift':'ok'}</span>`:''}</td></tr>`).join('')}</tbody></table></div><p class="note">Invested value ${gbp(M.invested)}. Equities include the equity share of alternatives only where accounts record it as equity. Holding-level drift across the eight classes arrives with portfolio tracking.</p>`:'<p class="muted">No account values recorded.</p>'}</div>
    <div class="panel"><h3>${esc(M.model?M.model.name+' target':'Model target')}</h3>${M.model?`<div class="tbl-wrap"><table><thead><tr><th>Asset class</th><th class="n">Target</th></tr></thead><tbody>${M.target8.map(t=>`<tr><td>${esc(t.l)}</td><td class="n">${t.pct}%</td></tr>`).join('')}<tr class="t"><td>Total</td><td class="n">${M.target8.reduce((a,t)=>a+t.pct,0)}%</td></tr></tbody></table></div>${M.model.description?`<p class="note">${esc(M.model.description)}</p>`:''}`:'<p class="muted">Choose a model portfolio under Mandate.</p>'}</div></div>`;
  h+=`<div class="panel"><h3>Objectives and constraints</h3><p><b>Objective:</b> ${esc(S_.objective||'–')}${has(S_.incomeNeed)?` · <b>Income required:</b> ${gbp(N(S_.incomeNeed))} a year`:''}${has(S_.horizon)?` · <b>Horizon:</b> ${S_.horizon} years`:''}</p><p><b>Restrictions:</b> ${esc(S_.restrictions||'None recorded')}</p><p class="muted">${S_.agreedOn?`Agreed ${fmtDate(S_.agreedOn)}${S_.agreedBy?' by '+esc(S_.agreedBy):''}.`:'Not yet agreed with the client.'}${S_.reviewedOn?` Last reviewed ${fmtDate(S_.reviewedOn)}.`:''}</p></div>`;
  return h;
}
function renderReviews(){
  const R=E.reviews();
  let h=`<div class="sec-head"><div><h2>Reviews due</h2><p>Every dated obligation for this household: the annual suitability review, the KYC refresh, document expiries, open actions, life events and complaint deadlines. Worked out from the file; nothing is entered here.</p></div></div>`+bannerHTML(false);
  h+=`<div class="kpis"><div class="kpi"><div class="k">Overdue</div><div class="v">${R.overdue}</div></div><div class="kpi"><div class="k">Due in 60 days</div><div class="v">${R.soon}</div></div><div class="kpi"><div class="k">Next due</div><div class="v t">${R.nextDue?fmtDate(R.nextDue):'Nothing scheduled'}</div></div></div>`;
  if(!R.items.length)return h+`<div class="empty">Nothing is due. Items appear once the file is approved, documents have dates, or actions, life events and complaints are recorded.</div>`;
  h+=`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Due</th><th>Status</th><th>Item</th><th>Who</th><th>Detail</th><th></th></tr></thead><tbody>${R.items.map(i=>`<tr><td style="white-space:nowrap">${fmtDate(i.due)}</td><td><span class="pill ${REVIEW_CLS[i.status]}">${i.status==='overdue'?Math.abs(i.days)+' days overdue':i.status==='soon'?'in '+i.days+' days':'scheduled'}</span></td><td><b>${esc(i.type)}</b></td><td>${esc(i.who)}</td><td class="muted">${esc(i.detail)}</td><td><button class="btn" type="button" data-nav="${esc(i.where)}">Open</button></td></tr>`).join('')}</tbody></table></div></div>`;
  return h;
}
async function renderDiary(){
  let h=`<div class="sec-head"><div><h2>Reviews due</h2><p>Households with the soonest obligation first. Open a household and go to Reviews due for the detail.</p></div></div>`;
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.list()}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(VIEW!=='diary')return;
  const t=H.today();const rows=list.filter(x=>x.due).sort((a,b)=>a.due.localeCompare(b.due));
  const overdue=rows.reduce((n,x)=>n+(x.overdue||0),0);
  h+=`<div class="kpis"><div class="kpi"><div class="k">Households with something overdue</div><div class="v">${rows.filter(x=>x.overdue).length}</div></div><div class="kpi"><div class="k">Overdue items</div><div class="v">${overdue}</div></div><div class="kpi"><div class="k">Due in the next 60 days</div><div class="v">${rows.filter(x=>x.due>=t&&x.due<=H.addDays(t,60)).length}</div></div></div>`;
  h+=`<div class="panel">${rows.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Household</th><th>Next due</th><th>Overdue</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.name||'Unnamed')}</b><br><span class="muted">${esc(x.reference||'')}</span></td><td>${fmtDate(x.due)}</td><td>${x.overdue?`<span class="pill bad">${x.overdue} overdue</span>`:`<span class="pill ${x.due<=H.addDays(t,60)?'warn':'neu'}">${x.due<=H.addDays(t,60)?'due soon':'scheduled'}</span>`}</td><td>${esc(x.stage)}</td><td><button class="btn" type="button" data-act="openHousehold" data-id="${esc(x.id)}" data-view="reviews">Open</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Nothing is due across the firm.</div>'}</div>`;
  $('#main').innerHTML=h;
}

function render(){
  renderNav();renderTopbar();const m=$('#main');
  if(VIEW==='clients')return renderClients();
  if(VIEW==='team')return renderTeam();
  if(VIEW==='diary')return renderDiary();
  if(VIEW==='tasks')return renderTasks();
  if(VIEW==='firmSettings'){m.innerHTML=renderFirmSettings();return}
  if(VIEW==='audit')return renderAudit();
  if(SCHEMA[VIEW])m.innerHTML=renderInput(VIEW);else if(VIEW==='bs')m.innerHTML=renderBS();else if(VIEW==='tax')m.innerHTML=renderTax();else if(VIEW==='risk')m.innerHTML=renderRisk();else if(VIEW==='kyc')m.innerHTML=renderKyc();else if(VIEW==='guide')m.innerHTML=renderGuide();else if(VIEW==='reviews')m.innerHTML=renderReviews();else if(VIEW==='drift')m.innerHTML=renderDrift();else if(VIEW==='letter')m.innerHTML=renderLetter();else m.innerHTML=renderChecks();
}
function renderTopbar(){
  const server=Store.mode==='server';const inHH=!FIRM_VIEWS.has(VIEW);
  $('#btnClients').hidden=!server||!inHH;
  for(const id of ['#btnImport','#btnExport','#btnJson'])$(id).hidden=!inHH;
  $('#resetWrap').hidden=server||!inHH;
  $('#who').innerHTML=server?`Signed in as <b>${esc(Store.user)}</b>${Store.cloud?' <button class="btn ghost" type="button" data-act="signOut">Sign out</button>':''}`:`<label for="whoIn">Working as</label><input id="whoIn" value="${esc(Store.user)}" placeholder="Your name">`;
  saveStatus();
}

/* ---------- editing ---------- */
function parseVal(f,raw,el){if(f.t===YN)return el?el.checked:raw;if(f.t==='num'||f.t==='pct'||f.t==='int'){if(raw===''||raw==null)return '';const n=parseFloat(String(raw).replace(/[£,%\s]/g,''));return isFinite(n)?n:''}return raw}
let navT;
function applyRtq(q){const r=H.rtqResult(q);if(!r)return;const m=S.members.find(x=>x.ref===q.owner);if(!m)return;const i=S.members.indexOf(m);
  for(const [k,v] of Object.entries(r))if(String(m[k])!==String(v)){logChange(`members[${i}].${k}`,m[k],v);m[k]=v}Store.touch()}
function onEdit(e){const el=e.target;
  if(el.id==='whoIn'){Store.user=el.value.trim();try{localStorage.setItem(LS_USER,Store.user)}catch(x){}return}
  if(!el.dataset||!el.dataset.k)return;const {col,idx,k}=el.dataset;const s=SCHEMA[col];const f=fieldsOf(s).find(x=>x.k===k);
  if(el.dataset.scope==='firm'){const v=parseVal(f,el.value,el.type==='checkbox'?el:null);const F=Store.firm.settings;const rec=s.single?F[col]:F[col][+idx];if(rec[k]===v)return;rec[k]=v;Store.touchFirm();
    if(!s.single){const card=document.querySelector(`[data-card="${col}:${idx}"]`);if(card){const [t,meta,val]=summary(col,rec);card.querySelector('.sum').innerHTML=`<b>${esc(t)}</b><span class="meta">${esc(meta)}</span>`;card.querySelector('.val').textContent=val}}return}
  const v=parseVal(f,el.value,el.type==='checkbox'?el:null);const rec=s.single?S[col]:S[col][+idx];const old=rec[k];if(old===v)return;rec[k]=v;
  logChange(s.single?`${col}.${k}`:`${col}[${idx}].${k}`,old,v);Store.touch();
  clearTimeout(impT);impT=setTimeout(()=>refreshImpact(`${s.title}: ${f.l}`,f),120);
  if(VALIDATE[k]){const msg=VALIDATE[k](v);const h=document.getElementById(el.id+'-h');el.setAttribute('aria-invalid',msg?'true':'false');if(h){h.textContent=msg||f.h||'';h.className='hint'+(msg?' err':'')}}
  if(!s.single){const card=document.querySelector(`[data-card="${col}:${idx}"]`);if(card){const [t,meta,val]=summary(col,rec);card.querySelector('.sum').innerHTML=`<b>${esc(t)}</b><span class="meta">${esc(meta)}</span>`;card.querySelector('.val').textContent=val}}
  clearTimeout(navT);navT=setTimeout(renderNav,250);
  if(col==='members'&&k==='role'&&e.type==='change')render();
  if(col==='rtq'&&e.type==='change'){applyRtq(rec);render()}
}
document.addEventListener('input',onEdit);document.addEventListener('change',onEdit);
document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-nav]');if(nav&&nav.dataset.nav){VIEW=nav.dataset.nav;if(banner&&!banner.sticky)banner=null;render();window.scrollTo({top:0});return}
  const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act,col=b.dataset.col,idx=+b.dataset.idx;
  if(act==='del'&&FIRM_KEYS.has(col)){e.stopPropagation();const rem=recs(col).splice(idx,1)[0];Store.touchFirm();banner={html:`Removed ${esc(summary(col,rem)[0])}. <button class="btn" type="button" data-act="undo">Undo</button>`,undo:{col,idx,rem,firm:true}};render();return}
  if(act==='del'){e.stopPropagation();const rem=S[col].splice(idx,1)[0];logChange(`${col}.count`,S[col].length+1,S[col].length);Store.touch();
    banner={html:`Removed ${esc(summary(col,rem)[0])}. <button class="btn" type="button" data-act="undo">Undo</button>`,undo:{col,idx,rem}};IMPACT.why=`<b>${esc(SCHEMA[col].item)} removed.</b> The figures above compare with when you opened this section.`;render();return}
  if(act==='undo'&&banner&&banner.undo&&banner.undo.firm){const u=banner.undo;recs(u.col).splice(u.idx,0,u.rem);banner=null;Store.touchFirm();render();return}
  if(act==='undo'&&banner&&banner.undo){const u=banner.undo;S[u.col].splice(u.idx,0,u.rem);logChange(`${u.col}.count`,S[u.col].length-1,S[u.col].length);banner=null;Store.touch();render();return}
  if(act==='closeBanner'){banner=null;render();return}
  if(act==='navGroup'){const g=b.dataset.g;const grp=NAV.find(x=>x[0]===g);if(grp.some(([id])=>id===VIEW))return;NAV_OPEN.has(g)?NAV_OPEN.delete(g):NAV_OPEN.add(g);renderNav();return}
  if(['goClients','team','diary','tasks','firmSettings'].includes(act)){await Store.flush();VIEW=act==='goClients'?'clients':act;banner=null;render();return}
  if(act==='signOut'){await Store.flush();if(Store.dirty||Store.err){toast('Changes are not saved yet. Try again in a moment.');return}await Store.cloud.signOut();location.reload();return}
  if(act==='invite'){const body={name:$('#invName').value.trim(),email:$('#invEmail').value.trim(),role:$('#invRole').value};b.disabled=true;
    try{await Store.api('POST','members',body);banner={cls:'good',html:`Invitation sent to ${esc(body.email)}.`}}catch(err){banner={cls:'bad',html:esc(err.message)}}render();return}
  if(act==='memberActive'){try{await Store.api('PATCH','members/'+encodeURIComponent(b.dataset.uid),{active:b.dataset.on==='1'});banner=null}catch(err){banner={cls:'bad',html:esc(err.message)}}render();return}
  if(act==='toggle'){if(e.target.closest('[data-act="del"]'))return;const key=col+':'+idx;OPEN.has(key)?OPEN.delete(key):OPEN.add(key);const card=b.closest('.card');card.dataset.open=OPEN.has(key);b.setAttribute('aria-expanded',OPEN.has(key));return}
  if(act==='toggleAll'&&FIRM_KEYS.has(col)){const L=recs(col);const all=L.every((_,i)=>OPEN.has(col+':'+i));L.forEach((_,i)=>all?OPEN.delete(col+':'+i):OPEN.add(col+':'+i));render();return}
  if(act==='toggleAll'){const all=S[col].every((_,i)=>OPEN.has(col+':'+i));S[col].forEach((_,i)=>all?OPEN.delete(col+':'+i):OPEN.add(col+':'+i));render();return}
  if(act==='add'&&FIRM_KEYS.has(col)){recs(col).push(H.defaults(col));OPEN.add(col+':'+(recs(col).length-1));Store.touchFirm();render();return}
  if(act==='rtqStart'){const r=Object.assign(H.defaults('rtq'),{owner:b.dataset.ref,by:Store.user||''});S.rtq.push(r);logChange('rtq.count',S.rtq.length-1,S.rtq.length);OPEN.add('rtq:'+(S.rtq.length-1));Store.touch();render();return}
  if(act==='loaLetter'){e.stopPropagation();LOA_IDX=+b.dataset.idx;VIEW='letter';banner=null;render();window.scrollTo({top:0});return}
  if(act==='print'){window.print();return}
  if(act==='reloadFirm'){banner=null;Store.firm.err=null;await Store.loadFirm();render();return}
  if(act==='taskFilter'){TASKF[b.dataset.k]=b.dataset.v;render();return}
  if(act==='add'){const r=H.defaults(col);if(col==='members'){const ad=S.members.filter(isAdult).length;r.ref=ad<1?'P1':ad<2?'P2':'C'+(S.members.filter(m=>m.role==='child').length+1);r.role=ad<1?'primary':ad<2?'partner':'child'}
    else if(['income','db','protection'].includes(col))r.owner=S.members[0]?.ref||'';else if(fieldsOf(SCHEMA[col]).some(f=>f.t==='owner'))r.owner=S.members.filter(isAdult).length>1?'JOINT':(S.members[0]?.ref||'');
    S[col].push(r);logChange(`${col}.count`,S[col].length-1,S[col].length);OPEN.add(col+':'+(S[col].length-1));Store.touch();IMPACT.why=`<b>${esc(SCHEMA[col].item)} added.</b> Fill it in and the figures above update as you type.`;render();const cards=document.querySelectorAll('.card');cards[cards.length-1]?.scrollIntoView({behavior:'smooth',block:'center'});return}
  if(act==='bsview'){BSVIEW=b.dataset.v;render();return}
  if(act==='resetAssump'){S.assumptions=H.defaults('assumptions');logChange('assumptions','edited','defaults restored');Store.touch();render();toast('Assumptions restored to 2026/27 defaults');return}
  if(act==='confirmReset'){setState(H.blank());S.household.name='';OPEN.clear();OPEN.add('members:0');Store.saveLocal();VIEW='household';resetUI(false);render();toast('Started a blank household');return}
  if(act==='loadSample'){setState(H.sample());Store.saveLocal();resetUI(false);render();toast('Sample household loaded');return}
  if(act==='cancelReset'){resetUI(false);return}
  if(act==='openHousehold'){try{await Store.open(b.dataset.id);banner=null;VIEW=b.dataset.view||'kyc';OPEN.clear();OPEN.add('members:0');render()}catch(err){toast('Could not open the household: '+err.message)}return}
  if(act==='newBlank'||act==='newSample'){try{const st=act==='newSample'?H.sample():H.blank();st.isSample=act==='newSample';await Store.create(st);setState(H.normalise(st));VIEW='household';banner=null;render()}catch(err){toast('Could not create the household: '+err.message)}return}
  if(act==='reloadHousehold'){try{await Store.open(Store.id);Store.err=null;banner=null;render();toast('Loaded the latest version')}catch(err){toast(err.message)}return}
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
  const ns=H.normalise(JSON.parse(JSON.stringify(S)));delete ns.audit;
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
    const audit=S.audit;setState(res.ns);if(Store.mode==='local'){S.audit=audit||[];logChange('import',file.name,res.report.join('; '))}
    Store.touch();OPEN.clear();OPEN.add('members:0');
    banner={cls:'ok',html:`<b>Imported ${esc(file.name)}.</b> ${esc(res.report.join(' · '))}. Check KYC and onboarding status for gaps.`};VIEW='members';render();
  }catch(err){banner={cls:'bad',html:`<b>Could not import ${esc(file.name)}.</b> ${esc(err.message)}`};render()}};

function outVal(f,v){if(f.t===YN)return yes(v)?'Yes':'No';if(f.t==='sel'){const o=optList(f.o).find(x=>String(x[0])===String(v));return o?o[1]:v}return v??''}
async function buildWorkbook(withData){
  const XLSX=await loadXLSX();const wb=XLSX.utils.book_new();
  const readme=[['Household Wealth Profiler: data template'],['One sheet per data type. Keep the sheet names and the header row. Each row is one record.'],['Link records to people with the Reference code from the Members sheet (P1, P2, C1…). Use JOINT for jointly owned items.'],['Percent columns take numbers such as 2.5 for 2.5%. Yes/No columns take Yes or No. Dates use YYYY-MM-DD.'],[],['Sheet','Column','Type','Allowed values / guidance']];
  for(const key of ['household','mandate','compliance',...COLS,'assumptions'])for(const f of fieldsOf(SCHEMA[key]))readme.push([SCHEMA[key].sheet,f.l,{text:'Text',num:'Number',pct:'Percent',int:'Whole number',date:'Date',sel:'List',bool:'Yes / No',area:'Text',owner:'Person ref or JOINT',member:'Person ref'}[f.t],(f.t==='sel'?optList(f.o).map(o=>o[1]).join(' | '):'')+(f.h?(f.t==='sel'?' — ':'')+f.h:'')]);
  const rws=XLSX.utils.aoa_to_sheet(readme);rws['!cols']=[{wch:16},{wch:40},{wch:18},{wch:90}];XLSX.utils.book_append_sheet(wb,rws,'README');
  for(const key of ['household','mandate','compliance']){const fs=fieldsOf(SCHEMA[key]);const ws=XLSX.utils.aoa_to_sheet([['Field','Value'],...fs.map(f=>[f.l,withData?outVal(f,S[key][f.k]):''])]);ws['!cols']=[{wch:44},{wch:50}];XLSX.utils.book_append_sheet(wb,ws,SCHEMA[key].sheet)}
  for(const key of COLS){const fs=fieldsOf(SCHEMA[key]);const aoa=[fs.map(f=>f.l)];if(withData)S[key].forEach(r=>aoa.push(fs.map(f=>outVal(f,r[f.k]))));const ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=fs.map(f=>({wch:Math.max(12,Math.min(30,f.l.length+2))}));XLSX.utils.book_append_sheet(wb,ws,SCHEMA[key].sheet)}
  {const fs=fieldsOf(SCHEMA.assumptions);const src=withData?S.assumptions:H.defaults('assumptions');const ws=XLSX.utils.aoa_to_sheet([['Field','Value'],...fs.map(f=>[f.l,outVal(f,src[f.k])])]);ws['!cols']=[{wch:40},{wch:14}];XLSX.utils.book_append_sheet(wb,ws,'Assumptions')}
  if(withData){const C=E.compute();const gl=Object.fromEntries([...GROUPS_A,...GROUPS_L]);const aoa=[['Side','Group','Line',...C.views.map(v=>v==='HH'?'Household':memberName(v))]];
    for(const l of C.lines)aoa.push([l.side==='A'?'Asset':'Liability',gl[l.group],l.label,...C.views.map(v=>Math.round(C.val(l,v)))]);
    aoa.push([]);aoa.push(['','','Economic net worth',...C.views.map(v=>Math.round(C.tot[v].A-C.tot[v].L))]);
    const ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=[{wch:10},{wch:30},{wch:44},...C.views.map(()=>({wch:14}))];XLSX.utils.book_append_sheet(wb,ws,'EconomicBalanceSheet');
    const O=E.onboarding(C);const ob=[['Status',O.stage],['AML risk rating',O.rating],['AML score',O.score],['EDD required',O.edd?'Yes':'No'],['Review every (years)',O.reviewYears],['Next review',O.nextReview||''],[],['Stage','Level','Item']];
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
const stamp=()=>(S.household.reference||S.household.name||'household').replace(/[^\w-]+/g,'_');
$('#btnTemplate').onclick=async()=>{try{save('household-data-template.xlsx',new Blob([await buildWorkbook(false)]))}catch(e){toast(e.message)}};
$('#btnExport').onclick=async()=>{try{save(stamp()+'-profile.xlsx',new Blob([await buildWorkbook(true)]))}catch(e){toast(e.message)}};
$('#btnJson').onclick=()=>save(stamp()+'-profile.json',JSON.stringify(S,null,2));
$('#btnClients').onclick=async()=>{await Store.flush();VIEW='clients';banner=null;render()};

/* ---------- start ---------- */
(async()=>{
  try{if(window.claude&&window.claude.use)window.claude.use('downloads').then(d=>{DL=d},()=>{})}catch(e){DL=null}
  try{await Store.init()}catch(e){if(!CFG.supabaseUrl)throw e;document.body.classList.add('gated');
    $('#main').innerHTML=`<div class="panel gate"><h2>Cannot open the profiler</h2><p>${esc(e.message)}</p>${Store.cloud?'<div class="addrow"><button class="btn" type="button" data-act="signOut">Sign out</button></div>':''}</div>`;return}
  await Store.loadFirm();
  if(Store.mode==='server'){setState(H.blank());VIEW='clients'}
  else{setState(Store.loadLocal()||H.sample())}
  resetUI(false);render();
})();
})();
