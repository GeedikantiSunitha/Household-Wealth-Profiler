/* Household Wealth Profiler: user interface.
   Uses window.HWP (core.js) for every calculation.
   Runs in two modes:
   - server: talks to server.js (logins, encrypted storage, versions, audit trail)
   - cloud:  the Supabase edition (config.js sets supabaseUrl); same as server mode, but signs in
             through cloud.js and calls the `api` Edge Function with a bearer token
   - local:  no server found; drafts stay in this browser only */
import { state, setState } from './state.js';
import { $, esc, toast } from './lib/dom.js';
import { gbp, gbpK, pct, fmtDate, fmtTs } from './lib/format.js';
import { Store, saveStatus, logChange, LS_USER, setRenderer } from './api/store.js';

(function(){
'use strict';
setRenderer(()=>render());
const H=window.HWP;
const {SCHEMA,COLS,SINGLES,YN,ROLES,WGROUP,EXP_CATS,ASSET_CLASSES,ROLLUP,fieldsOf,optList,N,has,yes}=H;

/* ---------- state (state.js: state.S, state.E, state.VIEW, state.BSVIEW, state.OPEN, state.banner, setState) ---------- */

/* ---------- helpers ---------- */
// $, esc, toast: lib/dom.js · gbp, gbpK, pct, fmtDate, fmtTs: lib/format.js
const memberName=r=>state.E.memberName(r);
const isAdult=m=>state.E.isAdult(m);

/* ---------- storage: api/store.js (Store, saveStatus, logChange, LS_USER) ---------- */

/* ---------- navigation ---------- */
const NAV=[
  ['Client data',[['household'],['members'],['income'],['expenses'],['goals'],['accounts'],['db'],['property'],['other'],['liabilities'],['protection'],['assumptions']]],
  ['Onboarding',[['compliance'],['kyc','KYC and onboarding status'],['audit','Audit trail']]],
  ['Relationship',[['contacts'],['actions'],['complaints'],['reviews','Reviews due']]],
  ['Mandate',[['mandate'],['models','Model portfolios'],['drift','Mandate check']]],
  ['Outputs',[['bs','Economic balance sheet'],['tax','Tax and allowances'],['risk','Risk profile and IPS'],['checks','Data checks'],['guide','How the model works']]]];
function renderNav(){
  if(state.VIEW==='clients'||state.VIEW==='team'||state.VIEW==='diary'){$('#rail').innerHTML=`<h6>${esc(Store.firm||'Clients')}</h6><button type="button" data-act="goClients" aria-current="${state.VIEW==='clients'}"><span>All households</span></button><button type="button" data-act="diary" aria-current="${state.VIEW==='diary'}" title="Every review, expiry, action and complaint deadline across all households"><span>Reviews due</span></button>${Store.role==='admin'?`<button type="button" data-act="team" aria-current="${state.VIEW==='team'}"><span>Team</span></button>`:''}`;$('#hhName').textContent=state.VIEW==='team'?'Team and access':state.VIEW==='diary'?'Reviews due across the firm':'Choose a household to open';return}
  let h='';let step=0;const O=state.E.onboarding();const bad=state.E.checks().filter(x=>x.lvl==='bad').length;
  for(const [sec,items] of NAV){h+=`<h6>${sec}</h6>`;for(const [id,lbl] of items){const s=SCHEMA[id];const name=lbl||s.title;
    let ct='',cls='';if(s&&!s.single)ct=state.S[id].length;
    if(id==='checks'&&bad){ct=bad+' to fix';cls='bad'}
    if(id==='kyc'){ct=O.blockerCount?O.blockerCount+' open':O.stage;cls=O.blockerCount?'bad':''}
    if(id==='reviews'){const R=state.E.reviews(O);ct=R.overdue?R.overdue+' overdue':R.soon?R.soon+' due soon':'';cls=R.overdue?'bad':''}
    if(id==='actions'){const n=state.S.actions.filter(a=>a.status==='Open').length;ct=n?n+' open':''}
    if(id==='drift'){const MC=state.E.mandateCheck();ct=MC.status;cls=MC.status==='Incomplete'?'bad':''}
    const st=s&&sec==='Client data'?`<span class="step">${String(++step).padStart(2,'0')}</span>`:'';
    h+=`<button type="button" data-nav="${id}" aria-current="${state.VIEW===id}" title="${esc(NAV_HELP[id]||'')}"><span>${st}${esc(name)}</span><span class="ct ${cls}">${esc(ct)}</span></button>`}}
  $('#rail').innerHTML=h;
  $('#hhName').textContent=(state.S.household.name||'Unnamed household')+(state.S.household.reference?' · '+state.S.household.reference:'')+' · '+O.stage;
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
  'actions.created':'When the action was raised.','actions.description':'What will be done.','actions.owner':'Who is responsible.','actions.due':'Open actions with a due date appear in Reviews due; overdue ones are highlighted.',
  'actions.status':'Open actions appear in Reviews due. Done and Cancelled are kept for the record.','actions.doneOn':'Date completed.',
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
  'Service and model':'Which model the portfolio follows and the risk level agreed. These set the target allocation.',
  'Objectives and constraints':'What the portfolio is for and what it may not hold. Recorded for the IPS; the drift tolerance drives the mandate check.',
  'Agreement':'When the mandate was agreed and last reviewed. Sets the annual mandate review date.',
  'Economic':'Inflation, discount rate, mortality and horizon that drive every present value.',
  'Income tax and NI (rest of UK)':'Bands and rates for the Tax view and after-tax human capital.',
  'Wrappers and pensions':'ISA and pension allowances for the allowance checks and deferred pension tax.',
  'Capital gains and inheritance tax':'CGT rates for deferred tax and IHT bands for the second-death estimate.'};
const NAV_HELP={mandate:'The investment mandate agreed with the client.',models:'The firm\u2019s risk-rated model portfolios.',drift:'Mandate against the current portfolio and the risk profile.',contacts:'Meetings, calls, review meetings and life events.',actions:'Agreed actions with owners and due dates.',complaints:'Complaints handled under DISP.',reviews:'Every dated obligation for this household.',household:'The file, legal status and legacy wish.',members:'Everyone in the household: ages, work, KYC and suitability.',income:'Earnings become human capital; pensions and benefits become income rights.',
  expenses:'Future spending, valued today as a liability.',goals:'One-off capital needs, valued today.',accounts:'Cash, ISAs, pensions and investments.',db:'Final salary pensions not yet in payment.',property:'Homes and investment property.',
  other:'Business interests and other assets.',liabilities:'Mortgages and debts.',protection:'Life and health cover.',assumptions:'Tax rules and economic assumptions behind every figure.',
  compliance:'Relationship, AML factors, disclosures and sign-off.',kyc:'Onboarding status worked out from everything recorded.',audit:'Who changed what, and when.',
  bs:'Present value of everything owned, earned and committed.',tax:'Income tax, NI and unused allowances per person.',risk:'Ability and willingness to take risk, and the IPS.',checks:'Data gaps and inconsistencies to fix.',guide:'How the calculations and onboarding rules work.'};
const tipBtn=(label,text,cls='')=>text?`<button type="button" class="tip ${cls}" aria-label="About ${esc(label)}" data-tip="${esc(text)}">i</button>`:'';

/* ---------- form rendering ---------- */
function ownerOptions(withJoint){let o=withJoint?[['JOINT','Joint (adults equally)']]:[];return o.concat(state.S.members.map(m=>[m.ref,`${m.ref} · ${m.firstName||''} ${m.lastName||''}`.trim()]))}
const VALIDATE={niNumber:v=>!v||H.validNino(v)?'':'Not a valid NI number',postcode:v=>!v||H.validPostcode(v)?'':'Check the postcode format',email:v=>!v||H.validEmail(v)?'':'Check the email address'};
function fieldHTML(col,idx,f,val){
  const id=`f-${col}-${idx}-${f.k}`;const data=`data-col="${col}" data-idx="${idx}" data-k="${f.k}"`;
  const vmsg=VALIDATE[f.k]?VALIDATE[f.k](val):'';
  const hint=vmsg?`<span class="hint err" id="${id}-h">${esc(vmsg)}</span>`:f.h?`<span class="hint" id="${id}-h">${esc(f.h)}</span>`:'';
  const aria=(vmsg||f.h?` aria-describedby="${id}-h"`:'')+(vmsg?' aria-invalid="true"':'');
  const tip=tipBtn(f.l,FIELD_HELP[`${col}.${f.k}`]||f.h);
  if(f.t===YN)return `<div class="f chk"><input type="checkbox" id="${id}" ${data} ${yes(val)?'checked':''}><span class="lab"><label for="${id}">${esc(f.l)}</label>${tip}</span></div>`;
  let ctl;
  if(f.t==='sel'||f.t==='member'||f.t==='owner'||f.t==='model'){const opts=f.t==='sel'?optList(f.o):f.t==='model'?state.S.models.map(m=>[m.name,m.name]):ownerOptions(f.t==='owner');const known=opts.some(o=>String(o[0])===String(val));
    ctl=`<select id="${id}" ${data}${aria}>${(f.t!=='sel'||!known)?`<option value="">${f.t==='sel'?'Select…':f.t==='model'?'Select model…':'Select person…'}</option>`:''}${opts.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(val)?'selected':''}>${esc(l)}</option>`).join('')}</select>`}
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
    case 'members':{const a=state.E.ageOf(r);return [`${r.ref||'?'} · ${r.firstName||'Unnamed'} ${r.lastName||''}`,`${(ROLES.find(x=>x[0]===r.role)||[0,''])[1]} · ${a!=null?'age '+Math.floor(a):'no date of birth'}${r.employment&&isAdult(r)?' · '+r.employment:''}`,''];}
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
    case 'actions':return [r.description||'Action',`${r.owner||''}${r.due?' · due '+fmtDate(r.due):''}`,r.status||''];
    case 'complaints':return [(r.summary||'Complaint').slice(0,70),`received ${fmtDate(r.received)} · ${r.stage||''}`,r.outcome||''];
  }return ['','',''];
}
function bannerHTML(household=true){let h='';
  if(household&&state.S&&state.S.isSample)h+=`<div class="banner sample"><div><b>Sample household.</b> These are made-up figures to show how the model works. Replace them with client data, import a file, or start blank.</div></div>`;
  if(state.banner)h+=`<div class="banner ${state.banner.cls||''}"><div>${state.banner.html}</div>${state.banner.sticky?'':'<button class="btn ghost x" type="button" data-act="closeBanner" aria-label="Dismiss">✕</button>'}</div>`;
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
  actions:{feeds:['Reviews due'],pts:[
    'Open actions with a due date appear in Reviews due, overdue ones first.',
    'Mark an action Done or Cancelled to clear it; the audit trail keeps the history.']},
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
const HOW_LS='hwp-how-open';const RECORD_ONLY=new Set(['contacts','actions','complaints','mandate','models']);
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
function metrics(){const C=state.E.compute();const k=C.kpi;const T=C.tot.HH;const O=state.E.onboarding(C);
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
  if(state.VIEW==='compliance')return kyc;
  if(state.VIEW==='members')return [fin[0],fin[1],kyc[1],kyc[2],kyc[3]];
  return [...fin,kyc[2]];
}
let IMPACT={view:null,base:{},why:''},impT;
function imCell(m){const base=IMPACT.base[m.id];const d=base===undefined?null:m.d(base,m.v);let cls='';
  if(d&&d[1]&&m.up)cls=(d[1]>0)===(m.up==='good')?'up':'down';
  return `<div class="im" data-m="${m.id}"><div class="k">${esc(m.k)}</div><div class="v">${esc(m.f(m.v))}</div><div class="d ${cls}">${d?esc(d[0]):''}</div></div>`}
function impactHTML(){const ms=metrics();
  if(IMPACT.view!==state.VIEW)IMPACT={view:state.VIEW,base:Object.fromEntries(ms.map(m=>[m.id,m.v])),why:''};
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
  if(s.single){h+=`<div class="card" data-open="true"><div class="card-b" style="border-top:0">${fieldsBlock(key,0,state.S[key])}</div></div>`;
    if(key==='assumptions')h+=`<p class="note">Figures reflect the 2026/27 tax year as announced. From April 2027 unused pensions fall into the estate for IHT, and savings and property income rates rise by 2 points; update these inputs when they take effect.</p><div class="addrow"><button class="btn" type="button" data-act="resetAssump">Restore defaults</button></div>`;
    if(key==='compliance')h+=`<div class="addrow"><button class="btn" type="button" data-nav="kyc">See onboarding status</button></div>`;
    return h}
  if(!state.S[key].length)h+=`<div class="empty">Nothing recorded yet. Use “Add ${esc(s.item)}” or import an Excel file.</div>`;
  state.S[key].forEach((r,i)=>{const [t,meta,v]=summary(key,r);const open=state.OPEN.has(key+':'+i);
    h+=`<div class="card" data-open="${open}" data-card="${key}:${i}"><div class="card-h" data-act="toggle" data-col="${key}" data-idx="${i}" role="button" tabindex="0" aria-expanded="${open}"><span class="chev">▸</span><span class="sum"><b>${esc(t)}</b><span class="meta">${esc(meta)}</span></span><span class="val">${esc(v)}</span><button class="btn ghost" type="button" data-act="del" data-col="${key}" data-idx="${i}">Remove</button></div><div class="card-b">${fieldsBlock(key,i,r)}</div></div>`});
  return h;
}

/* ---------- outputs ---------- */
const GROUPS_A=[['fin','Financial capital'],['real','Real assets'],['hc','Human capital'],['pen','Pension and income rights']];
const GROUPS_L=[['debt','Financial liabilities'],['cons','Consumption goals (PV)'],['goal','Capital goals and legacy (PV)'],['tax','Deferred tax']];
const COLORS={fin:'var(--asset)',real:'var(--asset2)',hc:'var(--hc)',pen:'var(--pen)',debt:'var(--liab)',cons:'var(--liab2)',goal:'var(--liab3)',tax:'var(--muted)'};
function renderBS(){
  const C=state.E.compute();const v=state.BSVIEW in C.tot?state.BSVIEW:'HH';const T=C.tot[v];const k=C.kpi;
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
    <tr><td class="muted">Estate ${gbp(k.estate)} · nil-rate bands ${gbp(k.nrb)} · residence band ${gbp(k.rnrb)}${yes(state.S.assumptions.pensionIHT)?' · pensions included':''}${k.coverInEstate?` · ${gbp(k.coverInEstate)} life cover not in trust`:''}</td><td></td></tr>
    <tr><td>Uncalled private-market commitments</td><td class="n">${gbp(k.uncalled)}</td></tr>
    <tr><td>Life and death-in-service cover in force</td><td class="n">${gbp(k.lifeCover)}</td></tr>
    <tr><td>Planning horizon (to last survivor at age ${esc(state.S.assumptions.planAge)})</td><td class="n">${k.H} yrs</td></tr></tbody></table></div>
    <p class="note">Method: human capital is the survival-weighted present value of after-tax earnings to retirement, discounted at the gilt rate plus an income-stability premium. Pension rights, including a spouse's pension from defined benefit schemes, and benefits such as ESA are discounted at the gilt rate. Spending and goals grow with inflation and are discounted at the gilt rate. Rental income is excluded because the property value already captures it. Joint items are split equally between the adults.</p></div>`;
  return h;
}
function renderTax(){
  const C=state.E.compute();const a=state.S.assumptions;let h=`<div class="sec-head"><div><h2>Tax and allowances</h2><p>Indicative 2026/27 position for each person, using rest-of-UK bands. Use it to spot unused allowances and cliff edges, not to file a return.</p></div></div>`+bannerHTML();
  const ad=state.S.members.filter(isAdult);const kids=state.S.members.filter(m=>m.role==='child');
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
    if(t.ani>N(a.hicbc)&&kids.some(k=>(state.E.ageOf(k)??99)<16))obs.push(['warn',`${n}: adjusted net income above ${gbp(N(a.hicbc))}. The High Income Child Benefit Charge applies if child benefit is claimed.`]);
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
  const C=state.E.compute();const R=state.E.riskProfile(C);const k=C.kpi;const a=state.S.assumptions;
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
  const near=state.S.goals.filter(g=>N(g.inYears)<=3).reduce((s,g)=>s+N(g.amount),0)+state.S.expenses.filter(e=>e.cat==='education'&&N(e.startIn)<=0).reduce((s,e)=>s+N(e.amount)*Math.min(3,has(e.duration)?N(e.duration):3),0);
  const fin=k.finAssets||1;const emp=state.S.accounts.filter(x=>x.wrapper==='Employer shares / options').reduce((s,x)=>s+N(x.value),0);
  const prot=ad.map(m=>{const hc=C.derived[m.ref].hc;const cover=state.S.protection.filter(p=>p.owner===m.ref&&/Life|Death|Family/.test(p.type)).reduce((s,p)=>s+N(p.sum),0);return {n:memberName(m.ref),hc,cover,gap:hc-cover}});
  const flags=[];if(!yes(state.S.household.willsInPlace))flags.push('no wills');if(!yes(state.S.household.lpaInPlace))flags.push('no lasting powers of attorney');ad.forEach(m=>{if(yes(m.usPerson))flags.push(memberName(m.ref)+' is a US person');if(m.residence!=='uk')flags.push(memberName(m.ref)+' is not UK resident')});
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
function renderChecks(){const list=state.E.checks();
  let h=`<div class="sec-head"><div><h2>Data checks</h2><p>Completeness and consistency tests run on every change. Fix the items marked Action before relying on the outputs.</p></div></div>`+bannerHTML();
  h+=`<div class="panel"><ul class="list">${list.length?list.map(c=>`<li><span class="pill ${c.lvl==='bad'?'bad':'warn'}">${c.lvl==='bad'?'Action':'Review'}</span><span class="grow">${esc(c.msg)}</span><button class="btn" type="button" data-nav="${c.where}">Open</button></li>`).join(''):'<li><span class="pill good">Clear</span><span>No issues found.</span></li>'}</ul></div>`;return h}

const STAGE_TEXT={done:'Complete',open:'Needs work',current:'Ready',waiting:'Not started'};
function renderKyc(){
  const O=state.E.onboarding();const c=state.S.compliance;
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
  if(state.VIEW!=='audit')return;
  const lab=p=>{const m=/^(\w+)(?:\[(\d+)\])?\.(\w+)$/.exec(p);if(!m)return p;const [,sec,i,k]=m;const s=SCHEMA[sec];if(!s)return p;if(k==='count')return `${s.title}: number of records`;const f=fieldsOf(s).find(x=>x.k===k);return `${s.title}${i!==undefined?' #'+(+i+1):''}: ${f?f.l:k}`};
  h+=`<div class="panel">${rows.length?`<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th><th>To</th></tr></thead><tbody>${rows.slice(0,1000).map(r=>`<tr><td style="white-space:nowrap">${esc(fmtTs(r.ts))}</td><td>${esc(r.user)}</td><td>${esc(r.field==='created'?'Household created':r.field==='import'?'Imported a file':lab(r.field))}</td><td class="mono">${esc(r.from)}</td><td class="mono">${esc(r.to)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No changes recorded yet.</p>'}</div>`;
  $('#main').innerHTML=h;
}
async function renderClients(){
  let h=`<div class="sec-head"><div><h2>Households</h2><p>Signed in as ${esc(Store.user)}. ${Store.encrypted?'Client files are encrypted at rest.':'<b>Encryption at rest is off.</b> Set DATA_KEY on the server.'}</p></div><div class="addrow"><button class="btn" type="button" data-act="newSample">New from sample</button><button class="btn primary" type="button" data-act="newBlank">New household</button></div></div>`;
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.list()}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>Could not load households. ${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='clients')return;
  const rc={Low:'good',Medium:'warn',High:'bad',Prohibited:'bad'};
  h+=`<div class="panel">${list.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Household</th><th>Status</th><th>AML</th><th>Next due</th><th>Last change</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${esc(x.name||'Unnamed')}</b><br><span class="muted">${esc(x.reference||'')}</span></td><td>${esc(x.stage)}${x.blockers?` <span class="pill bad">${x.blockers}</span>`:''}</td><td><span class="pill ${rc[x.rating]||'neu'}">${esc(x.rating)}</span></td><td>${x.due?fmtDate(x.due):'–'}${x.overdue?` <span class="pill bad">${x.overdue} overdue</span>`:''}</td><td>${esc(fmtTs(x.updatedAt))}<br><span class="muted">${esc(x.updatedBy||'')}</span></td><td><button class="btn" type="button" data-act="openHousehold" data-id="${esc(x.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No households yet. Create one to start onboarding.</div>'}</div>`;
  $('#main').innerHTML=h;
}

async function renderTeam(){
  let h=`<div class="sec-head"><div><h2>Team</h2><p>People at ${esc(Store.firm)} who can sign in. Each person needs their own login so the audit trail shows who did what. Deactivating someone signs them out at once; their past entries stay in the audit trail.</p></div></div>`+bannerHTML(false);
  $('#main').innerHTML=h+`<div class="panel"><p class="muted">Loading…</p></div>`;
  let list=[];try{list=await Store.api('GET','members')}catch(e){$('#main').innerHTML=h+`<div class="banner bad"><div>${esc(e.message)}</div></div>`;return}
  if(state.VIEW!=='team')return;
  const used=list.filter(x=>x.active).length;
  h+=`<div class="panel"><h3>Invite someone</h3><p class="muted">${used} of ${Store.seats} seats in use. They get an email link to choose a password and set up two-step verification.</p>
    <div class="fields"><div class="f"><label for="invName">Name</label><input id="invName" autocomplete="off"></div><div class="f"><label for="invEmail">Email</label><input id="invEmail" type="email" autocomplete="off"></div>
    <div class="f"><label for="invRole">Role</label><select id="invRole"><option value="adviser">Adviser: works on client files</option><option value="admin">Administrator: also manages the team</option></select></div></div>
    <div class="addrow"><button class="btn primary" type="button" data-act="invite"${used>=Store.seats?' disabled':''}>Send invitation</button></div></div>`;
  h+=`<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${x.role==='admin'?'Administrator':'Adviser'}</td><td><span class="pill ${x.active?'good':'neu'}">${x.active?'Active':'Deactivated'}</span></td><td>${x.email===Store.email?'<span class="muted">You</span>':`<button class="btn" type="button" data-act="memberActive" data-uid="${esc(x.userId)}" data-on="${x.active?'0':'1'}">${x.active?'Deactivate':'Reactivate'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#main').innerHTML=h;
}

function renderGuide(){
  const a=state.S.assumptions;const C=state.E.compute();const k=C.kpi;
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
function renderDrift(){
  const M=state.E.mandateCheck();const S_=state.S.mandate;const scls={'In line':'good',Drift:'warn',Incomplete:'bad'}[M.status];
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
  const R=state.E.reviews();
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
  if(state.VIEW!=='diary')return;
  const t=H.today();const rows=list.filter(x=>x.due).sort((a,b)=>a.due.localeCompare(b.due));
  const overdue=rows.reduce((n,x)=>n+(x.overdue||0),0);
  h+=`<div class="kpis"><div class="kpi"><div class="k">Households with something overdue</div><div class="v">${rows.filter(x=>x.overdue).length}</div></div><div class="kpi"><div class="k">Overdue items</div><div class="v">${overdue}</div></div><div class="kpi"><div class="k">Due in the next 60 days</div><div class="v">${rows.filter(x=>x.due>=t&&x.due<=H.addDays(t,60)).length}</div></div></div>`;
  h+=`<div class="panel">${rows.length?`<div class="tbl-wrap"><table class="clients"><thead><tr><th>Household</th><th>Next due</th><th>Overdue</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.name||'Unnamed')}</b><br><span class="muted">${esc(x.reference||'')}</span></td><td>${fmtDate(x.due)}</td><td>${x.overdue?`<span class="pill bad">${x.overdue} overdue</span>`:`<span class="pill ${x.due<=H.addDays(t,60)?'warn':'neu'}">${x.due<=H.addDays(t,60)?'due soon':'scheduled'}</span>`}</td><td>${esc(x.stage)}</td><td><button class="btn" type="button" data-act="openHousehold" data-id="${esc(x.id)}" data-view="reviews">Open</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Nothing is due across the firm.</div>'}</div>`;
  $('#main').innerHTML=h;
}

function render(){
  renderNav();renderTopbar();const m=$('#main');
  if(state.VIEW==='clients')return renderClients();
  if(state.VIEW==='team')return renderTeam();
  if(state.VIEW==='diary')return renderDiary();
  if(state.VIEW==='audit')return renderAudit();
  if(SCHEMA[state.VIEW])m.innerHTML=renderInput(state.VIEW);else if(state.VIEW==='bs')m.innerHTML=renderBS();else if(state.VIEW==='tax')m.innerHTML=renderTax();else if(state.VIEW==='risk')m.innerHTML=renderRisk();else if(state.VIEW==='kyc')m.innerHTML=renderKyc();else if(state.VIEW==='guide')m.innerHTML=renderGuide();else if(state.VIEW==='reviews')m.innerHTML=renderReviews();else if(state.VIEW==='drift')m.innerHTML=renderDrift();else m.innerHTML=renderChecks();
}
function renderTopbar(){
  const server=Store.mode==='server';const inHH=!['clients','team','diary'].includes(state.VIEW);
  $('#btnClients').hidden=!server||!inHH;
  for(const id of ['#btnImport','#btnExport','#btnJson'])$(id).hidden=!inHH;
  $('#resetWrap').hidden=server||!inHH;
  $('#who').innerHTML=server?`Signed in as <b>${esc(Store.user)}</b>${Store.cloud?' <button class="btn ghost" type="button" data-act="signOut">Sign out</button>':''}`:`<label for="whoIn">Working as</label><input id="whoIn" value="${esc(Store.user)}" placeholder="Your name">`;
  saveStatus();
}

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
