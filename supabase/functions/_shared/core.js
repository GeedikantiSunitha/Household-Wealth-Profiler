/* Household Wealth Profiler: shared core.
   Schema, UK tax engine, CFA economic balance sheet, risk profile,
   data checks and KYC/AML onboarding rules.
   Pure JavaScript with no DOM access: runs in the browser (window.HWP)
   and in Node (require('./core.js')), so the server and the tests use
   exactly the same calculations as the screen. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.HWP = m;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* =========================================================
   1. SCHEMA. Add a field here and it appears in the form,
   the Excel template, import, export and the audit trail.
   ========================================================= */
const YN = 'bool';
const ROLES = [['primary','Primary client'],['partner','Spouse / partner'],['child','Child'],['dependant','Other dependant']];
const INCOME_TYPES = ['Employment salary','Bonus / commission','Self-employment profit','Director dividends','Rental profit','State Pension (in payment)','DB pension (in payment)','Annuity','ESA (Employment and Support Allowance)','Other state benefits','Trust distribution','Maintenance received','Other income'];
const HC_TYPES = ['Employment salary','Bonus / commission','Self-employment profit','Director dividends'];
const PENSION_PAY = ['State Pension (in payment)','DB pension (in payment)','Annuity'];
const WRAPPERS = ['Current account','Cash savings','Cash ISA','Stocks & Shares ISA','Lifetime ISA','Junior ISA','Innovative Finance ISA','Child Trust Fund','Premium Bonds / NS&I','General investment account','Onshore bond','Offshore bond','SIPP','Workplace DC pension','Personal pension','VCT','EIS / SEIS','Private markets fund','Employer shares / options','Crypto'];
const WGROUP = {'Current account':'cash','Cash savings':'cash','Cash ISA':'cash','Premium Bonds / NS&I':'cash',
  'Stocks & Shares ISA':'isa','Lifetime ISA':'isa','Junior ISA':'isa','Innovative Finance ISA':'isa','Child Trust Fund':'isa',
  'General investment account':'taxable','Onshore bond':'taxable','Offshore bond':'taxable','Employer shares / options':'taxable','Crypto':'taxable',
  'SIPP':'pension','Workplace DC pension':'pension','Personal pension':'pension','VCT':'alt','EIS / SEIS':'alt','Private markets fund':'alt'};
const ISA_SUBS = ['Cash ISA','Stocks & Shares ISA','Lifetime ISA','Innovative Finance ISA'];
const SINGLE_OWNER = ['Cash ISA','Stocks & Shares ISA','Lifetime ISA','Junior ISA','Innovative Finance ISA','Child Trust Fund','SIPP','Workplace DC pension','Personal pension','Premium Bonds / NS&I'];
const CGT_WRAP = ['General investment account','Employer shares / options','Crypto'];
const PROPERTY_TYPES = ['Main residence','Second home','Buy-to-let','Furnished holiday let','Commercial property','Overseas property','Land'];
const OTHER_TYPES = ['Private company shares','Partnership capital','Art & collectibles','Wine','Vehicles','Loan owed to you','Other asset'];
const LIAB_TYPES = ['Residential mortgage','Buy-to-let mortgage','Lombard / securities-backed loan','Personal loan','Car finance','Credit card','Student loan (Plan 1)','Student loan (Plan 2)','Student loan (Plan 4)','Student loan (Plan 5)','Postgraduate loan',"Director's loan",'Tax due','Other liability'];
const PROT_TYPES = ['Life cover (level)','Life cover (decreasing)','Family income benefit','Death in service','Critical illness','Income protection','Private medical'];
const EXP_CATS = [['essential','Essential'],['discretionary','Discretionary'],['aspirational','Aspirational'],['education','Education'],['care','Later-life care']];

const SCHEMA = {
  household:{single:true,title:'Household',sheet:'Household',desc:'Who this plan is for and the legal status that shapes tax and estate planning.',fields:[
    {k:'name',l:'Household name',t:'text',w:1},
    {k:'reference',l:'Client reference',t:'text'},
    {k:'adviser',l:'Lead adviser',t:'text'},
    {k:'valuationDate',l:'Valuation date',t:'date',d:()=>today()},
    {k:'relationship',l:'Relationship status',t:'sel',o:[['single','Single'],['married','Married'],['civil','Civil partnership'],['cohabiting','Cohabiting'],['separated','Separated / divorcing'],['widowed','Widowed']],d:'married',h:'Married and civil partners share IHT nil-rate bands; cohabitees do not.'},
    {k:'region',l:'UK nation',t:'sel',o:['England','Wales','Scotland','Northern Ireland'],d:'England',h:'Scottish income tax bands differ.'},
    {k:'willsInPlace',l:'Wills in place',t:YN},
    {k:'lpaInPlace',l:'Lasting powers of attorney',t:YN},
    {k:'trusts',l:'Existing trusts',t:YN},
    {k:'giftsLast7',l:'Gifts in last 7 years (£)',t:'num',h:'Failed potentially exempt transfers use the nil-rate band first.'},
    {k:'bequestTarget',l:"Legacy target (£, today's money)",t:'num',h:'Amount to leave on second death. Treated as a liability.'},
    {k:'objectives',l:"Objectives in the client's words",t:'area',w:1},
  ]},
  members:{title:'People',sheet:'Members',item:'person',desc:'Every adult and dependant. Reference codes (P1, P2, C1…) link income, accounts and debts to a person. Identity and screening sections appear for adults only.',groups:[
    {t:'Identity',fields:[
      {k:'ref',l:'Reference',t:'text',h:'P1, P2 for adults; C1, C2 for children'},
      {k:'title',l:'Title',t:'text'},
      {k:'firstName',l:'First name',t:'text'},{k:'lastName',l:'Last name',t:'text'},
      {k:'role',l:'Role',t:'sel',o:ROLES,d:'primary'},
      {k:'dob',l:'Date of birth',t:'date'},
      {k:'sex',l:'Sex (mortality basis)',t:'sel',o:[['F','Female'],['M','Male']],d:'F'},
      {k:'health',l:'Health',t:'sel',o:['Excellent','Good','Impaired','Serious condition'],d:'Good',h:'Impaired or serious health shortens assumed life expectancy.'},
      {k:'smoker',l:'Smoker',t:YN}]},
    {t:'Contact and address',adultOnly:true,fields:[
      {k:'niNumber',l:'National Insurance number',t:'text',h:'Format AB 12 34 56 C'},
      {k:'nationality',l:'Nationality',t:'text'},
      {k:'otherNationality',l:'Other nationalities',t:'text'},
      {k:'countryOfBirth',l:'Country of birth',t:'text'},
      {k:'address',l:'Residential address',t:'text',w:1},
      {k:'postcode',l:'Postcode',t:'text'},
      {k:'addressSince',l:'At this address since',t:'date',h:'Under 3 years: record the previous address'},
      {k:'prevAddress',l:'Previous address',t:'text',w:1},
      {k:'email',l:'Email',t:'text'},
      {k:'phone',l:'Phone',t:'text'}]},
    {t:'Identity verification',adultOnly:true,fields:[
      {k:'idType',l:'Photo ID',t:'sel',o:['Passport','Driving licence (photocard)','National identity card','Biometric residence permit / eVisa'],d:'Passport'},
      {k:'idNumber',l:'Document number',t:'text'},
      {k:'idExpiry',l:'Document expiry',t:'date'},
      {k:'idMethod',l:'How verified',t:'sel',o:[['none','Not yet verified'],['inperson','Original seen in person'],['certified','Certified copy'],['electronic','Electronic identity check']],d:'none'},
      {k:'idCheckedDate',l:'ID checked on',t:'date'},
      {k:'poaType',l:'Proof of address',t:'sel',o:[['none','Not yet obtained'],['utility','Utility bill'],['bank','Bank or building society statement'],['council','Council tax bill'],['hmrc','HMRC letter'],['electronic','Electronic address check']],d:'none'},
      {k:'poaDate',l:'Proof of address dated',t:'date',h:'Must be dated within 3 months of onboarding'}]},
    {t:'Screening',adultOnly:true,fields:[
      {k:'pep',l:'Politically exposed person',t:'sel',o:[['no','Not a PEP'],['domestic','Domestic PEP'],['foreign','Foreign or international PEP'],['rca','Family member or close associate of a PEP']],d:'no'},
      {k:'pepDetail',l:'PEP role and country',t:'text'},
      {k:'sanctions',l:'Sanctions screening',t:'sel',o:[['none','Not screened'],['clear','No match'],['potential','Potential match, under review'],['falsepos','Match discounted as false positive'],['confirmed','Confirmed match']],d:'none'},
      {k:'adverseMedia',l:'Adverse media',t:'sel',o:[['none','Not checked'],['clear','Nothing found'],['found','Adverse media found']],d:'none'},
      {k:'screenDate',l:'Screened on',t:'date',h:'Must be within 3 months of onboarding'}]},
    {t:'Source of wealth and tax status',adultOnly:true,fields:[
      {k:'sow',l:'Main source of wealth',t:'sel',o:['Employment income','Business ownership or sale','Inheritance','Property','Investment returns','Pension','Gift','Divorce settlement','Other'],d:''},
      {k:'sowEvidence',l:'Source of wealth evidence',t:'sel',o:[['none','Not obtained'],['obtained','Obtained'],['verified','Verified']],d:'none'},
      {k:'sowDetail',l:'Source of wealth: how it was built',t:'area',w:1,h:'Dates, amounts and documents seen'},
      {k:'taxResidencies',l:'Tax residencies (CRS)',t:'text',d:'United Kingdom',h:'Separate countries with semicolons'},
      {k:'tins',l:'Non-UK tax ID numbers',t:'text'},
      {k:'crsSelfCert',l:'CRS / FATCA self-certification signed',t:YN}]},
    {t:'Work and retirement',fields:[
      {k:'employment',l:'Employment status',t:'sel',o:['Employed','Self-employed','Company director','Partner (LLP)','Retired','Not working','Carer','Student'],d:'Employed'},
      {k:'occupation',l:'Occupation',t:'text'},
      {k:'sector',l:'Sector',t:'text'},
      {k:'occRisk',l:'Income stability',t:'sel',o:[['low','Very stable (e.g. public sector)'],['medium','Stable salaried'],['high','Variable (bonus, commission)'],['vhigh','Volatile (founder, freelance)']],d:'medium',h:'Sets the human-capital discount premium and how equity-like earnings are.'},
      {k:'retireAge',l:'Planned retirement age',t:'int',d:65}]},
    {t:'Tax and residence',fields:[
      {k:'residence',l:'Tax residence',t:'sel',o:[['uk','UK resident'],['nonuk','Non-UK resident'],['split','Split year / treaty case']],d:'uk'},
      {k:'ukYears',l:'UK-resident years (last 20)',t:'int',h:'10+ of the last 20 makes a long-term resident: worldwide assets in IHT.'},
      {k:'arrivalYear',l:'Year arrived in UK',t:'int',h:'Within 4 years of arrival may qualify for the FIG regime.'},
      {k:'scottish',l:'Scottish taxpayer',t:YN},
      {k:'usPerson',l:'US citizen / green card',t:YN},
      {k:'niYears',l:'NI qualifying years',t:'int'},
      {k:'spForecast',l:'State Pension forecast (£/week)',t:'num',h:'Leave blank to estimate from NI years.'},
      {k:'flexAccessed',l:'Has flexibly accessed a pension',t:YN,h:'Triggers the Money Purchase Annual Allowance.'},
      {k:'retTaxRate',l:'Expected retirement tax rate (%)',t:'pct',d:20}]},
    {t:'Investor profile and suitability',adultOnly:true,fields:[
      {k:'riskTol',l:'Risk tolerance (1–7)',t:'sel',o:[['1','1 · Very cautious'],['2','2 · Cautious'],['3','3 · Moderately cautious'],['4','4 · Balanced'],['5','5 · Moderately adventurous'],['6','6 · Adventurous'],['7','7 · Very adventurous']],d:'4'},
      {k:'lossReaction',l:'If portfolio fell 25%',t:'sel',o:[['sellall','Sell everything'],['sellsome','Sell some'],['hold','Hold'],['buy','Buy more']],d:'hold'},
      {k:'experience',l:'Knowledge and experience',t:'sel',o:['None','Basic','Informed','Advanced'],d:'Basic'},
      {k:'capacity',l:'Capacity for loss (adviser view)',t:'sel',o:[['low','Low'],['medium','Medium'],['high','High']],d:'medium'},
      {k:'esg',l:'Sustainability preference',t:'sel',o:['None','Some','Strong'],d:'None'},
      {k:'vulnerability',l:'Vulnerability (FCA drivers)',t:'sel',o:['None identified','Health','Life event','Resilience','Capability'],d:'None identified'},
      {k:'supportNeeds',l:'Support needs and adjustments',t:'text',w:1,h:'Required when a vulnerability is recorded'}]}
  ]},
  income:{title:'Income',sheet:'Income',item:'income',desc:"Gross annual amounts in today's money. Earnings become human capital; pensions in payment and benefits such as ESA become income rights.",fields:[
    {k:'owner',l:'Person',t:'member'},
    {k:'type',l:'Type',t:'sel',o:INCOME_TYPES,d:'Employment salary'},
    {k:'label',l:'Source / employer',t:'text'},
    {k:'amount',l:'Gross £ per year',t:'num'},
    {k:'growth',l:'Growth % p.a.',t:'pct',d:2.5},
    {k:'startAge',l:'Starts at age',t:'int',h:'Blank = already started'},
    {k:'endAge',l:'Ends at age',t:'int',h:'Blank = retirement for earnings, plan end otherwise'},
    {k:'taxable',l:'Taxable',t:YN,d:true,h:'Contribution-based ESA is taxable; income-related ESA is not.'},
  ]},
  expenses:{title:'Spending',sheet:'Expenses',item:'spending line',desc:"Annual household spending in today's money. Leave mortgage payments out: the mortgage balance is already a liability.",fields:[
    {k:'label',l:'Description',t:'text'},
    {k:'cat',l:'Category',t:'sel',o:EXP_CATS,d:'essential'},
    {k:'amount',l:'£ per year (today)',t:'num'},
    {k:'inflation',l:'Inflation % (blank = CPI)',t:'pct'},
    {k:'startIn',l:'Starts in (years)',t:'int',d:0},
    {k:'duration',l:'Lasts (years)',t:'int',h:'Blank = to end of plan'},
  ]},
  goals:{title:'Goals',sheet:'Goals',item:'goal',desc:'One-off capital needs such as university fees, a house deposit for a child or a business injection.',fields:[
    {k:'label',l:'Goal',t:'text'},
    {k:'amount',l:'Amount £ (today)',t:'num'},
    {k:'inYears',l:'Needed in (years)',t:'int'},
    {k:'priority',l:'Priority',t:'sel',o:[['need','Need'],['want','Want'],['wish','Wish']],d:'want'},
  ]},
  accounts:{title:'Savings and investments',sheet:'Accounts',item:'account',desc:'Cash, ISAs, pensions and investment accounts. Contributions are for the current tax year and drive allowance checks.',fields:[
    {k:'owner',l:'Owner',t:'owner'},
    {k:'wrapper',l:'Wrapper',t:'sel',o:WRAPPERS,d:'Stocks & Shares ISA'},
    {k:'provider',l:'Provider',t:'text'},
    {k:'value',l:'Value £',t:'num'},
    {k:'baseCost',l:'Base cost £',t:'num',h:'For capital gains on GIAs, shares, crypto and bonds'},
    {k:'contrib',l:'Your contributions this tax year £',t:'num',h:'Pensions: gross amount'},
    {k:'employerContrib',l:'Employer contributions this year £',t:'num'},
    {k:'reliefMethod',l:'Pension tax relief',t:'sel',o:['n/a','Relief at source','Net pay','Salary sacrifice'],d:'n/a'},
    {k:'eq',l:'Equities %',t:'pct'},{k:'bd',l:'Bonds %',t:'pct'},{k:'cs',l:'Cash %',t:'pct'},{k:'al',l:'Alternatives %',t:'pct'},
    {k:'yield',l:'Income yield %',t:'pct',h:'Interest or dividend yield'},
    {k:'fee',l:'All-in annual cost %',t:'pct'},
    {k:'liquidity',l:'Access',t:'sel',o:['Instant','Under 30 days','Under 1 year','Locked'],d:'Instant'},
    {k:'uncalled',l:'Uncalled commitment £',t:'num',h:'Private markets only'},
  ]},
  db:{title:'Defined benefit pensions',sheet:'DBPensions',item:'scheme',desc:'Final salary and career-average schemes not yet in payment. Pensions already in payment go under Income.',fields:[
    {k:'owner',l:'Member',t:'member'},
    {k:'scheme',l:'Scheme',t:'text'},
    {k:'status',l:'Status',t:'sel',o:['Active','Deferred'],d:'Deferred'},
    {k:'accrued',l:'Accrued pension £ per year',t:'num'},
    {k:'nra',l:'Normal retirement age',t:'int',d:65},
    {k:'indexation',l:'Indexation % p.a.',t:'pct',d:2.5},
    {k:'spousePct',l:"Spouse's pension %",t:'pct',d:50},
    {k:'cetv',l:'Transfer value (CETV) £',t:'num'},
  ]},
  property:{title:'Property',sheet:'Property',item:'property',desc:'Homes and investment property. Record rent under Income and mortgages under Liabilities.',fields:[
    {k:'owner',l:'Owner',t:'owner'},
    {k:'type',l:'Type',t:'sel',o:PROPERTY_TYPES,d:'Main residence'},
    {k:'label',l:'Address / name',t:'text'},
    {k:'value',l:'Market value £',t:'num'},
    {k:'share',l:'Household share %',t:'pct',d:100},
    {k:'baseCost',l:'Purchase cost £',t:'num'},
  ]},
  other:{title:'Business and other assets',sheet:'OtherAssets',item:'asset',desc:'Private company shares, partnership capital, collectibles and loans owed to the household.',fields:[
    {k:'owner',l:'Owner',t:'owner'},
    {k:'type',l:'Type',t:'sel',o:OTHER_TYPES,d:'Private company shares'},
    {k:'label',l:'Description',t:'text'},
    {k:'value',l:'Value £',t:'num'},
    {k:'baseCost',l:'Base cost £',t:'num'},
    {k:'badr',l:'Business Asset Disposal Relief eligible',t:YN},
    {k:'bpr',l:'Business Relief (IHT) eligible',t:YN},
  ]},
  liabilities:{title:'Liabilities',sheet:'Liabilities',item:'liability',desc:'Outstanding balances today.',fields:[
    {k:'owner',l:'Borrower',t:'owner'},
    {k:'type',l:'Type',t:'sel',o:LIAB_TYPES,d:'Residential mortgage'},
    {k:'lender',l:'Lender',t:'text'},
    {k:'balance',l:'Balance £',t:'num'},
    {k:'rate',l:'Interest rate %',t:'pct'},
    {k:'fixedUntil',l:'Rate fixed until',t:'date'},
    {k:'payment',l:'Monthly payment £',t:'num'},
    {k:'term',l:'Remaining term (years)',t:'int'},
    {k:'interestOnly',l:'Interest-only',t:YN},
  ]},
  protection:{title:'Protection',sheet:'Protection',item:'policy',desc:"Cover in force. Life cover is compared with each earner's human capital; cover not in trust is added to the estate.",fields:[
    {k:'owner',l:'Life assured',t:'member'},
    {k:'type',l:'Type',t:'sel',o:PROT_TYPES,d:'Life cover (level)'},
    {k:'provider',l:'Provider',t:'text'},
    {k:'sum',l:'Sum assured or benefit £ p.a.',t:'num'},
    {k:'inTrust',l:'Written in trust',t:YN},
    {k:'expiryAge',l:'Cover ends at age',t:'int'},
    {k:'premium',l:'Premium £ per month',t:'num'},
  ]},
  compliance:{single:true,title:'Onboarding and compliance',sheet:'Compliance',desc:'The relationship, disclosures, enhanced due diligence and the four-eyes sign-off. Identity and screening for each adult are recorded under People.',groups:[
    {t:'The relationship',fields:[
      {k:'serviceType',l:'Service',t:'sel',o:['Ongoing advice','Discretionary management','One-off financial plan'],d:'Ongoing advice'},
      {k:'categorisation',l:'Client categorisation',t:'sel',o:[['retail','Retail client'],['elective','Elective professional client'],['perse','Per se professional client']],d:'retail'},
      {k:'meeting',l:'How the client was met',t:'sel',o:[['f2f','Face to face'],['video','Video call with ID shown'],['remote','Not met (non face-to-face)']],d:'f2f'},
      {k:'referral',l:'Introduced by',t:'text'},
      {k:'purpose',l:'Purpose and intended nature of the relationship',t:'area',w:1},
      {k:'expectedInvestment',l:'Expected investment £',t:'num'},
      {k:'fundsCountry',l:'Funds coming from (country)',t:'text',d:'United Kingdom'},
      {k:'fundsRoute',l:'Funds route',t:'sel',o:["UK bank account in client's name",'Non-UK bank account','Transfer from another provider','Third-party payment'],d:"UK bank account in client's name"},
      {k:'complexStructure',l:'Trusts, companies or offshore structures involved',t:YN},
      {k:'highRiskCountry',l:'Links to a high-risk third country',t:YN,h:'On the UK high-risk list. Enhanced due diligence is mandatory.'},
      {k:'cashIntensive',l:'Cash-intensive business or wealth',t:YN}]},
    {t:'Disclosures and consents',fields:[
      {k:'termsDate',l:'Client agreement signed',t:'date'},
      {k:'feeDate',l:'Fee agreement signed',t:'date'},
      {k:'costsDate',l:'Costs and charges disclosed (ex-ante)',t:'date'},
      {k:'privacyDate',l:'Privacy notice provided',t:'date'},
      {k:'healthConsent',l:'Explicit consent to record health data',t:YN,h:'Needed when a health vulnerability is recorded'},
      {k:'marketingConsent',l:'Marketing consent',t:YN},
      {k:'targetMarket',l:'Target market check done',t:YN},
      {k:'suitabilityDate',l:'Suitability report issued',t:'date'}]},
    {t:'Enhanced due diligence',fields:[
      {k:'eddNotes',l:'EDD findings',t:'area',w:1,h:'Required when the AML rating is high'},
      {k:'seniorApprover',l:'Senior manager approval (name)',t:'text',h:'Required for PEP relationships'},
      {k:'seniorApprovalDate',l:'Senior approval given on',t:'date'}]},
    {t:'Sign-off',fields:[
      {k:'riskNote',l:'Risk profile rationale',t:'area',w:1,h:'Required when willingness and ability to take risk differ'},
      {k:'preparer',l:'Prepared by',t:'text'},
      {k:'preparedDate',l:'Prepared on',t:'date'},
      {k:'reviewer',l:'Compliance reviewer',t:'text',h:'Must be a different person from the preparer'},
      {k:'reviewDate',l:'Reviewed on',t:'date'},
      {k:'outcome',l:'Outcome',t:'sel',o:[['pending','Pending review'],['approved','Approved'],['conditions','Approved with conditions'],['declined','Declined']],d:'pending'},
      {k:'reviewNotes',l:'Reviewer notes',t:'area',w:1}]}
  ]},
  assumptions:{single:true,title:'Assumptions',sheet:'Assumptions',desc:'Tax year 2026/27 rules and economic assumptions. Check the tax figures against HMRC before relying on them.',groups:[
    {t:'Economic',fields:[
      {k:'cpi',l:'CPI inflation %',t:'pct',d:2.5},{k:'rf',l:'Risk-free rate % (gilts)',t:'pct',d:4.25},
      {k:'spIndex',l:'State Pension uprating %',t:'pct',d:3.0},{k:'planAge',l:'Plan to age',t:'int',d:100},
      {k:'gM',l:'Modal age at death, male',t:'num',d:87},{k:'gF',l:'Modal age at death, female',t:'num',d:90},{k:'gB',l:'Mortality dispersion (years)',t:'num',d:10},
      {k:'pLow',l:'HC premium: very stable %',t:'pct',d:1},{k:'pMed',l:'HC premium: stable %',t:'pct',d:2},{k:'pHigh',l:'HC premium: variable %',t:'pct',d:3.5},{k:'pVhigh',l:'HC premium: volatile %',t:'pct',d:5},
      {k:'hcAfterTax',l:'Human capital after tax',t:YN,d:true},{k:'survLiab',l:'Weight spending by survival',t:YN,d:false,h:'Off = plan spending to the planning age (prudent).'}]},
    {t:'Income tax and NI (rest of UK)',fields:[
      {k:'pa',l:'Personal allowance',t:'num',d:12570},{k:'brl',l:'Higher-rate threshold',t:'num',d:50270},{k:'arl',l:'Additional-rate threshold',t:'num',d:125140},{k:'paTaper',l:'Allowance taper starts',t:'num',d:100000},
      {k:'r1',l:'Basic rate %',t:'pct',d:20},{k:'r2',l:'Higher rate %',t:'pct',d:40},{k:'r3',l:'Additional rate %',t:'pct',d:45},
      {k:'d1',l:'Dividend basic %',t:'pct',d:10.75},{k:'d2',l:'Dividend higher %',t:'pct',d:35.75},{k:'d3',l:'Dividend additional %',t:'pct',d:39.35},
      {k:'divAll',l:'Dividend allowance',t:'num',d:500},{k:'psaB',l:'Savings allowance (basic)',t:'num',d:1000},{k:'psaH',l:'Savings allowance (higher)',t:'num',d:500},{k:'srs',l:'Starting rate for savings',t:'num',d:5000},
      {k:'ni1',l:'Employee NI main %',t:'pct',d:8},{k:'ni2',l:'Employee NI upper %',t:'pct',d:2},{k:'c41',l:'Class 4 main %',t:'pct',d:6},{k:'c42',l:'Class 4 upper %',t:'pct',d:2},
      {k:'hicbc',l:'Child benefit charge starts',t:'num',d:60000}]},
    {t:'Wrappers and pensions',fields:[
      {k:'isa',l:'ISA allowance',t:'num',d:20000},{k:'lisa',l:'Lifetime ISA allowance',t:'num',d:4000},{k:'jisa',l:'Junior ISA allowance',t:'num',d:9000},
      {k:'aa',l:'Pension annual allowance',t:'num',d:60000},{k:'mpaa',l:'Money Purchase Annual Allowance',t:'num',d:10000},{k:'aaMin',l:'Tapered allowance floor',t:'num',d:10000},
      {k:'tThresh',l:'Taper: threshold income',t:'num',d:200000},{k:'tAdj',l:'Taper: adjusted income',t:'num',d:260000},{k:'lsa',l:'Lump sum allowance',t:'num',d:268275},
      {k:'spFull',l:'Full new State Pension £/week',t:'num',d:241.30}]},
    {t:'Capital gains and inheritance tax',fields:[
      {k:'cgtAE',l:'CGT annual exempt amount',t:'num',d:3000},{k:'cgtL',l:'CGT basic rate %',t:'pct',d:18},{k:'cgtH',l:'CGT higher rate %',t:'pct',d:24},{k:'badrRate',l:'BADR rate %',t:'pct',d:18},
      {k:'nrb',l:'IHT nil-rate band',t:'num',d:325000},{k:'rnrb',l:'Residence nil-rate band',t:'num',d:175000},{k:'rnrbTaper',l:'RNRB taper threshold',t:'num',d:2000000},{k:'ihtRate',l:'IHT rate %',t:'pct',d:40},
      {k:'pensionIHT',l:'Include pensions in estate (from Apr 2027)',t:YN,d:true}]}
  ]}
};
const COLS = ['members','income','expenses','goals','accounts','db','property','other','liabilities','protection'];
const SINGLES = ['household','compliance','assumptions'];
const fieldsOf = s => s.groups ? s.groups.flatMap(g=>g.fields) : s.fields;

/* =========================================================
   2. STATE HELPERS AND SAMPLE DATA
   ========================================================= */
function today(){return new Date().toISOString().slice(0,10)}
function defaults(key){const o={};for(const f of fieldsOf(SCHEMA[key])){if(f.d!==undefined)o[f.k]=typeof f.d==='function'?f.d():f.d;else o[f.k]=f.t===YN?false:'';}return o}
function blank(){const s={isSample:false};for(const k of SINGLES)s[k]=defaults(k);for(const c of COLS)s[c]=[];return s}
function mk(key,o){return Object.assign(defaults(key),o)}
function normalise(s){
  s=s&&typeof s==='object'?s:{};const out=blank();out.isSample=!!s.isSample;
  for(const k of SINGLES)out[k]=Object.assign(defaults(k),pick(s[k],k));
  for(const c of COLS)out[c]=(Array.isArray(s[c])?s[c]:[]).map(r=>Object.assign(defaults(c),pick(r,c)));
  if(Array.isArray(s.audit))out.audit=s.audit.slice(-2000);
  return out;
}
/* Keep only schema keys with primitive values, so imported or
   uploaded JSON cannot inject unexpected properties. */
function pick(r,key){const o={};if(!r||typeof r!=='object')return o;for(const f of fieldsOf(SCHEMA[key])){const v=r[f.k];if(v===undefined||v===null)continue;if(['string','number','boolean'].includes(typeof v))o[f.k]=v}return o}

function sample(){
  const s=blank(); s.isSample=true;
  Object.assign(s.household,{name:'Harrington household',reference:'HH-0001',adviser:'Sam Adviser',valuationDate:today(),relationship:'married',region:'England',willsInPlace:true,lpaInPlace:false,trusts:false,giftsLast7:0,bequestTarget:500000,
    objectives:"James would like to stop full-time work at 60. Fund school and university for both children and help each with a first home. Leave around £500k in today's money to the children."});
  const d=n=>{const x=new Date();x.setDate(x.getDate()-n);return x.toISOString().slice(0,10)};
  const fwd=n=>{const x=new Date();x.setFullYear(x.getFullYear()+n);return x.toISOString().slice(0,10)};
  s.members=[
    mk('members',{ref:'P1',title:'Mr',firstName:'James',lastName:'Harrington',role:'primary',dob:'1979-03-14',sex:'M',health:'Good',
      niNumber:'JH 12 34 56 A',nationality:'British',countryOfBirth:'United Kingdom',address:'1 Example Lane, Guildford',postcode:'GU1 1AA',addressSince:'2014-06-01',email:'james@example.com',
      idType:'Passport',idNumber:'000000001',idExpiry:fwd(6),idMethod:'inperson',idCheckedDate:d(10),poaType:'council',poaDate:d(40),
      pep:'no',sanctions:'clear',adverseMedia:'clear',screenDate:d(10),sow:'Employment income',sowEvidence:'verified',sowDetail:'Partner earnings since 2012 (tax returns seen) and sale of former employer shares in 2021.',crsSelfCert:true,
      employment:'Partner (LLP)',occupation:'Equity partner',sector:'Professional services',occRisk:'high',retireAge:60,residence:'uk',ukYears:20,niYears:25,retTaxRate:40,riskTol:'5',lossReaction:'hold',experience:'Informed',capacity:'medium',esg:'Some'}),
    mk('members',{ref:'P2',title:'Mrs',firstName:'Priya',lastName:'Harrington',role:'partner',dob:'1982-07-02',sex:'F',health:'Excellent',
      niNumber:'PH 65 43 21 B',nationality:'British',countryOfBirth:'United Kingdom',address:'1 Example Lane, Guildford',postcode:'GU1 1AA',addressSince:'2014-06-01',email:'priya@example.com',
      idType:'Driving licence (photocard)',idNumber:'HARRI000000PH9AB',idExpiry:fwd(3),idMethod:'inperson',idCheckedDate:d(10),poaType:'none',
      pep:'no',sanctions:'clear',adverseMedia:'clear',screenDate:d(10),sow:'Employment income',sowEvidence:'obtained',crsSelfCert:true,
      employment:'Employed',occupation:'Teacher (part-time)',sector:'Education',occRisk:'low',retireAge:62,residence:'uk',ukYears:20,niYears:18,retTaxRate:20,riskTol:'3',lossReaction:'sellsome',experience:'Basic',capacity:'medium'}),
    mk('members',{ref:'C1',firstName:'Arjun',lastName:'Harrington',role:'child',dob:'2012-05-20',sex:'M',employment:'Student',retireAge:'',ukYears:14}),
    mk('members',{ref:'C2',firstName:'Maya',lastName:'Harrington',role:'child',dob:'2017-01-11',sex:'F',employment:'Student',retireAge:'',ukYears:9})];
  s.income=[
    mk('income',{owner:'P1',type:'Self-employment profit',label:'LLP profit share',amount:185000,growth:3}),
    mk('income',{owner:'P1',type:'Self-employment profit',label:'Discretionary profit pool',amount:40000,growth:2}),
    mk('income',{owner:'P2',type:'Employment salary',label:'Local authority school',amount:28000,growth:2.5}),
    mk('income',{owner:'P1',type:'Rental profit',label:'Flat, Leeds (50%)',amount:7200,growth:2}),
    mk('income',{owner:'P2',type:'Rental profit',label:'Flat, Leeds (50%)',amount:7200,growth:2})];
  s.expenses=[
    mk('expenses',{label:'Core household bills and food',cat:'essential',amount:60000}),
    mk('expenses',{label:'Lifestyle and leisure',cat:'discretionary',amount:30000}),
    mk('expenses',{label:'Travel',cat:'aspirational',amount:15000,duration:25}),
    mk('expenses',{label:'School fees, Arjun',cat:'education',amount:24000,inflation:5,duration:2}),
    mk('expenses',{label:'School fees, Maya',cat:'education',amount:24000,inflation:5,duration:7}),
    mk('expenses',{label:'Later-life care provision',cat:'care',amount:50000,inflation:4,startIn:35,duration:4})];
  s.goals=[
    mk('goals',{label:'University, Arjun',amount:45000,inYears:2,priority:'need'}),
    mk('goals',{label:'University, Maya',amount:45000,inYears:7,priority:'need'}),
    mk('goals',{label:'House deposits for children',amount:100000,inYears:12,priority:'want'})];
  s.accounts=[
    mk('accounts',{owner:'JOINT',wrapper:'Current account',provider:'High-street bank',value:25000,cs:100,yield:0.5}),
    mk('accounts',{owner:'P1',wrapper:'Cash savings',provider:'Easy-access saver',value:60000,cs:100,yield:4}),
    mk('accounts',{owner:'P1',wrapper:'Premium Bonds / NS&I',provider:'NS&I',value:50000,cs:100,liquidity:'Under 30 days'}),
    mk('accounts',{owner:'P2',wrapper:'Cash ISA',provider:'Building society',value:32000,contrib:8000,cs:100,yield:4.2}),
    mk('accounts',{owner:'P1',wrapper:'Stocks & Shares ISA',provider:'Wealth manager A',value:245000,contrib:20000,eq:80,bd:15,cs:5,fee:0.95}),
    mk('accounts',{owner:'P2',wrapper:'Stocks & Shares ISA',provider:'Wealth manager A',value:118000,contrib:12000,eq:70,bd:25,cs:5,fee:0.95}),
    mk('accounts',{owner:'P1',wrapper:'SIPP',provider:'Platform B',value:520000,contrib:40000,reliefMethod:'Relief at source',eq:75,bd:20,cs:5,fee:0.6,liquidity:'Locked'}),
    mk('accounts',{owner:'P1',wrapper:'Workplace DC pension',provider:'Previous employer scheme',value:310000,eq:70,bd:25,cs:5,fee:0.4,liquidity:'Locked'}),
    mk('accounts',{owner:'P1',wrapper:'General investment account',provider:'Wealth manager A',value:180000,baseCost:120000,eq:85,bd:10,cs:5,yield:2,fee:1.1}),
    mk('accounts',{owner:'P1',wrapper:'Employer shares / options',provider:'Former employer plc',value:95000,baseCost:40000,eq:100,yield:3}),
    mk('accounts',{owner:'P1',wrapper:'Private markets fund',provider:'PE fund of funds',value:75000,al:100,fee:1.8,liquidity:'Locked',uncalled:50000}),
    mk('accounts',{owner:'C1',wrapper:'Junior ISA',provider:'Platform B',value:28000,contrib:9000,eq:100,fee:0.3,liquidity:'Locked'}),
    mk('accounts',{owner:'C2',wrapper:'Junior ISA',provider:'Platform B',value:14000,contrib:9000,eq:100,fee:0.3,liquidity:'Locked'})];
  s.db=[mk('db',{owner:'P2',scheme:"Teachers' Pension Scheme",status:'Active',accrued:9800,nra:67,indexation:2.5,spousePct:37.5,cetv:165000})];
  s.property=[
    mk('property',{owner:'JOINT',type:'Main residence',label:'Family home, Surrey',value:1450000,baseCost:780000}),
    mk('property',{owner:'JOINT',type:'Buy-to-let',label:'Flat, Leeds',value:420000,baseCost:260000})];
  s.other=[mk('other',{owner:'P1',type:'Art & collectibles',label:'Paintings and prints',value:40000,baseCost:25000})];
  s.liabilities=[
    mk('liabilities',{owner:'JOINT',type:'Residential mortgage',lender:'Lender C',balance:520000,rate:4.4,fixedUntil:'2028-03-31',payment:3100,term:17}),
    mk('liabilities',{owner:'JOINT',type:'Buy-to-let mortgage',lender:'Lender D',balance:210000,rate:5.1,payment:893,term:12,interestOnly:true}),
    mk('liabilities',{owner:'P2',type:'Credit card',lender:'Card issuer',balance:2400,rate:22.9})];
  s.protection=[
    mk('protection',{owner:'P1',type:'Life cover (level)',provider:'Insurer E',sum:500000,inTrust:false,expiryAge:70,premium:62}),
    mk('protection',{owner:'P1',type:'Income protection',provider:'Insurer E',sum:90000,expiryAge:60,premium:118}),
    mk('protection',{owner:'P2',type:'Death in service',provider:"Teachers' Pension Scheme",sum:84000,inTrust:true}),
    mk('protection',{owner:'P2',type:'Critical illness',provider:'Insurer F',sum:150000,expiryAge:65,premium:41})];
  Object.assign(s.compliance,{serviceType:'Ongoing advice',categorisation:'retail',meeting:'f2f',referral:'Existing client referral',
    purpose:'Ongoing advice on investments, pensions and retirement planning across the whole household balance sheet.',expectedInvestment:900000,
    termsDate:d(7),feeDate:d(7),privacyDate:d(14),targetMarket:true,preparer:'Sam Adviser',preparedDate:d(2)});
  return s;
}

/* =========================================================
   3. GENERIC HELPERS
   ========================================================= */
const N=v=>{const n=parseFloat(v);return isFinite(n)?n:0};
const has=v=>v!==''&&v!==null&&v!==undefined&&!(typeof v==='number'&&isNaN(v));
const yes=v=>v===true||v==='true';
function optList(o){return o.map(x=>Array.isArray(x)?x:[x,x])}
const normKey=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const isAdultRole=m=>m.role==='primary'||m.role==='partner';
function parseDate(s){if(!s)return null;const d=new Date(String(s).slice(0,10)+'T00:00:00Z');return isNaN(d)?null:d}
function daysBetween(a,b){return (b-a)/864e5}
function addYears(s,n){const d=parseDate(s);if(!d)return '';d.setUTCFullYear(d.getUTCFullYear()+n);return d.toISOString().slice(0,10)}

/* Validators used by onboarding checks */
function validNino(v){const s=String(v||'').replace(/\s+/g,'').toUpperCase();return /^(?!BG|GB|NK|KN|TN|NT|ZZ)[ABCEGHJ-PRSTW-Z][ABCEGHJ-NPRSTW-Z]\d{6}[A-D]$/.test(s)}
function validPostcode(v){return /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i.test(String(v||'').trim())}
function validEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'').trim())}

/* Convert a raw spreadsheet value into the type a field expects */
function coerce(f,raw,cell){
  if(raw===undefined||raw===null||raw==='')return f.t===YN?false:'';
  if(f.t===YN){const s=normKey(raw);return ['yes','y','true','1','x'].includes(s)}
  if(f.t==='date'){if(raw instanceof Date&&!isNaN(raw))return new Date(raw.getTime()-raw.getTimezoneOffset()*6e4).toISOString().slice(0,10);const d=new Date(raw);return isNaN(d)?String(raw):new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)}
  if(f.t==='num'||f.t==='int'||f.t==='pct'){let n=typeof raw==='number'?raw:parseFloat(String(raw).replace(/[£,%\s]/g,''));if(!isFinite(n))return '';if(f.t==='pct'&&cell&&cell.z&&String(cell.z).includes('%'))n=n*100;return f.t==='int'?Math.round(n):+n.toFixed(6)}
  if(f.t==='sel'){const opts=optList(f.o);const hit=opts.find(([v,l])=>normKey(v)===normKey(raw)||normKey(l)===normKey(raw));return hit?hit[0]:String(raw)}
  if(f.t==='owner'||f.t==='member'){const s=String(raw).trim();if(normKey(s)==='joint')return 'JOINT';return s.toUpperCase()}
  return String(raw);
}

/* =========================================================
   4. ENGINE. bind(state) returns calculators for one household.
   ========================================================= */
function bind(S){
const A=()=>S.assumptions;
function memberName(ref){if(ref==='JOINT')return 'Joint';const m=S.members.find(x=>x.ref===ref);return m?(m.firstName||m.ref):ref||'Unassigned'}
const isAdult=isAdultRole;
function adults(){const a=S.members.filter(isAdult);return a.length?a:S.members}
function ageOf(m){if(!m||!m.dob)return null;const a=parseDate(m.dob),b=parseDate(S.household.valuationDate||today());if(!a||!b)return null;const y=(b-a)/(365.2425*864e5);return isFinite(y)?y:null}
function ownerAlloc(owner){if(owner==='JOINT'){const ad=adults();const o={};ad.forEach(m=>o[m.ref]=1/ad.length);return o}return owner?{[owner]:1}:{}}

/* Mortality: Gompertz survival, adjusted for health and smoking */
function gomp(m){const a=A();let mode=N(m.sex==='M'?a.gM:a.gF)||88;if(yes(m.smoker))mode-=6;if(m.health==='Impaired')mode-=5;if(m.health==='Serious condition')mode-=12;if(m.health==='Excellent')mode+=1.5;return {m:mode,b:N(a.gB)||10}}
function surv(m,age,t){const g=gomp(m);return Math.exp(Math.exp((age-g.m)/g.b)-Math.exp((age+t-g.m)/g.b))}
function lifeExp(m,age){let e=0;for(let t=1;t<=120-age;t++)e+=surv(m,age,t);return e}
function spa(m){if(!m.dob)return 67;const d=parseDate(m.dob);if(d<parseDate('1960-04-06'))return 66;if(d<parseDate('1977-04-06'))return 67;return 68}

/* UK income tax, rest-of-UK bands. Income is taxed in the statutory
   order: non-savings, then savings, then dividends. Relief-at-source
   pension contributions extend the basic and higher rate bands. */
function incomeTax(nonSav,sav,div,ras){
  const a=A();const ani=nonSav+sav+div-ras;
  const pa=Math.max(0,N(a.pa)-Math.max(0,(ani-N(a.paTaper))/2));
  const B1=(N(a.brl)-N(a.pa))+ras, B2=N(a.arl)+ras;
  let p=pa;const tNS=Math.max(0,nonSav-p);p=Math.max(0,p-nonSav);const tS=Math.max(0,sav-p);p=Math.max(0,p-sav);const tD=Math.max(0,div-p);
  const slice=(start,amt,r)=>{if(amt<=0)return 0;let t=0;const e=start+amt;for(const [lo0,hi0,rt] of [[0,B1,r[0]],[B1,B2,r[1]],[B2,Infinity,r[2]]]){const lo=Math.max(start,lo0),hi=Math.min(e,hi0);if(hi>lo)t+=(hi-lo)*rt/100}return t};
  const R=[N(a.r1),N(a.r2),N(a.r3)],D=[N(a.d1),N(a.d2),N(a.d3)];
  let pos=0,tax=0;tax+=slice(pos,tNS,R);pos+=tNS;
  const top=tNS+tS+tD;
  const psa=top<=B1?N(a.psaB):top<=B2?N(a.psaH):0;const sr=Math.max(0,N(a.srs)-tNS);
  const zs=Math.min(tS,sr+psa);pos+=zs;tax+=slice(pos,tS-zs,R);pos+=tS-zs;
  const zd=Math.min(tD,N(a.divAll));pos+=zd;tax+=slice(pos,tD-zd,D);
  return {tax,pa,ani,top,band:top<=0?'Nil':top<=B1?'Basic':top<=B2?'Higher':'Additional'};
}
function niCalc(emp,self){const a=A();const lo=N(a.pa),hi=N(a.brl);const band=x=>[Math.max(0,Math.min(x,hi)-lo),Math.max(0,x-hi)];const [e1,e2]=band(emp),[s1,s2]=band(self);return e1*N(a.ni1)/100+e2*N(a.ni2)/100+s1*N(a.c41)/100+s2*N(a.c42)/100}

function memberTax(m){
  const a=A();const inc=S.income.filter(i=>i.owner===m.ref);
  let emp=0,self=0,div=0,nonSavOther=0,sav=0;const age=ageOf(m)||0;
  for(const i of inc){const v=N(i.amount);
    if(has(i.startAge)&&N(i.startAge)>age)continue; if(has(i.endAge)&&N(i.endAge)<=age)continue;
    if(i.taxable===false||i.taxable==='false')continue;
    if(i.type==='Employment salary'||i.type==='Bonus / commission')emp+=v;else if(i.type==='Self-employment profit')self+=v;else if(i.type==='Director dividends')div+=v;else nonSavOther+=v;}
  let ras=0,netpay=0,er=0,isaUsed=0,lisaUsed=0,jisaUsed=0,unreal=0;
  for(const ac of S.accounts){const sh=ownerAlloc(ac.owner)[m.ref]||0;if(!sh)continue;const v=N(ac.value)*sh,y=N(ac.yield)/100;
    if(ac.wrapper==='Current account'||ac.wrapper==='Cash savings')sav+=v*y;
    if(ac.wrapper==='General investment account'||ac.wrapper==='Employer shares / options')div+=v*y;
    if(WGROUP[ac.wrapper]==='pension'){const c=N(ac.contrib)*sh;if(ac.reliefMethod==='Net pay')netpay+=c;else if(ac.reliefMethod!=='Salary sacrifice')ras+=c;er+=N(ac.employerContrib)*sh}
    if(ISA_SUBS.includes(ac.wrapper))isaUsed+=N(ac.contrib)*sh;
    if(ac.wrapper==='Lifetime ISA')lisaUsed+=N(ac.contrib)*sh;
    if(ac.wrapper==='Junior ISA')jisaUsed+=N(ac.contrib)*sh;
    if(CGT_WRAP.includes(ac.wrapper)&&has(ac.baseCost))unreal+=Math.max(0,N(ac.value)-N(ac.baseCost))*sh;}
  const run=(xEmp=0)=>{const ns=emp+xEmp+self+nonSavOther-netpay;const it=incomeTax(Math.max(0,ns),sav,div,ras);const ni=niCalc(emp+xEmp,self);return {...it,ni}};
  const base=run();const up=run(100);
  const earned=emp+self+div;
  const noEarn=incomeTax(Math.max(0,nonSavOther-netpay),sav,0,ras).tax;
  const hcRate=earned>0?Math.min(0.6,Math.max(0,(base.tax+base.ni-noEarn)/earned)):0;
  const gross=emp+self+div+nonSavOther+sav;
  const threshold=base.ani, adjusted=base.ani+ras+netpay+er;
  let aa=N(a.aa);const tapered=threshold>N(a.tThresh)&&adjusted>N(a.tAdj);
  if(tapered)aa=Math.max(N(a.aaMin),N(a.aa)-(adjusted-N(a.tAdj))/2);
  if(yes(m.flexAccessed))aa=Math.min(aa,N(a.mpaa));
  const penUsed=ras+netpay+er;
  return {emp,self,div,nonSavOther,sav,gross,ras,netpay,er,...base,marginal:(up.tax+up.ni-base.tax-base.ni)/100,hcRate,threshold,adjusted,aa,tapered,penUsed,isaUsed,lisaUsed,jisaUsed,unreal,
    cgtRate:(base.band==='Higher'||base.band==='Additional')?N(a.cgtH)/100:N(a.cgtL)/100};
}

/* Economic balance sheet (CFA Institute private wealth approach) */
function compute(){
  const a=A();const rf=N(a.rf)/100,cpi=N(a.cpi)/100;
  const lines=[];const add=(side,group,label,value,alloc,note)=>{if(Math.abs(value)<0.5)return;lines.push({side,group,label,value,alloc,note})};
  const tax={};S.members.forEach(m=>tax[m.ref]=memberTax(m));
  const prem={low:N(a.pLow),medium:N(a.pMed),high:N(a.pHigh),vhigh:N(a.pVhigh)};
  const adl=adults();
  const ages=adl.map(m=>ageOf(m)).filter(x=>x!=null);
  const H=Math.max(1,Math.round(ages.length?Math.max(...ages.map(ag=>N(a.planAge)-ag)):40));
  const derived={};
  for(const m of S.members){const age=ageOf(m);derived[m.ref]={age,le:age!=null?lifeExp(m,age):null,hc:0}}
  const retRate=m=>(has(m.retTaxRate)?N(m.retTaxRate):20)/100;

  const wLabel={cash:'Cash and deposits',isa:'ISAs',taxable:'Taxable investments',pension:'Defined contribution pensions',alt:'Alternatives and illiquid'};
  for(const ac of S.accounts){const g=WGROUP[ac.wrapper]||'taxable';add('A','fin',wLabel[g],N(ac.value),ownerAlloc(ac.owner))}
  for(const p of S.property){const v=N(p.value)*(has(p.share)?N(p.share)/100:1);add('A','real',p.type==='Main residence'?'Main residence':'Other property',v,ownerAlloc(p.owner))}
  for(const o of S.other){add('A','real',['Private company shares','Partnership capital'].includes(o.type)?'Business interests':'Collectibles and other',N(o.value),ownerAlloc(o.owner))}

  // Human capital and income rights. Income received at the end of each year.
  for(const i of S.income){const m=S.members.find(x=>x.ref===i.owner);if(!m)continue;const age=derived[m.ref].age;if(age==null)continue;
    if(i.type==='Rental profit')continue; // the property value already captures rent
    const isHC=HC_TYPES.includes(i.type);const isPen=PENSION_PAY.includes(i.type);
    const endAge=has(i.endAge)?N(i.endAge):isHC?(N(m.retireAge)||65):N(a.planAge);
    const startOff=has(i.startAge)?Math.max(0,N(i.startAge)-age):0;
    const n=Math.max(0,Math.round(endAge-age));
    const r=isHC?rf+(prem[m.occRisk]??2)/100:rf;const g=N(i.growth)/100;
    const tr=(i.taxable===false||i.taxable==='false')?0:isHC?(yes(a.hcAfterTax)?tax[m.ref].hcRate:0):retRate(m);
    let pv=0;for(let t=1;t<=n;t++){if(t<=startOff)continue;pv+=N(i.amount)*Math.pow(1+g,t-1)*(1-tr)*surv(m,age,t)/Math.pow(1+r,t)}
    if(isHC){add('A','hc',`${memberName(m.ref)}: ${i.type.toLowerCase()}`,pv,{[m.ref]:1});derived[m.ref].hc+=pv;}
    else add('A','pen',isPen?`${memberName(m.ref)}: ${i.type.replace(' (in payment)','')} in payment`:`${memberName(m.ref)}: ${i.type}`,pv,{[m.ref]:1});
  }
  // State Pension not yet in payment
  for(const m of adl){const age=derived[m.ref].age;if(age==null)continue;
    if(S.income.some(i=>i.owner===m.ref&&i.type==='State Pension (in payment)'))continue;
    const S0=spa(m);let wk;
    if(has(m.spForecast))wk=N(m.spForecast);
    else{const yrsToSpa=Math.max(0,S0-age);const workYrs=Math.max(0,Math.min(yrsToSpa,(N(m.retireAge)||S0)-age));const q=Math.min(35,N(m.niYears)+workYrs);wk=q<10?0:N(a.spFull)*q/35;}
    const g=N(a.spIndex)/100;const tr=retRate(m);let pv=0;
    for(let t=1;t<=Math.round(N(a.planAge)-age);t++){if(age+t<S0)continue;pv+=wk*52.18*Math.pow(1+g,t)*(1-tr)*surv(m,age,t)/Math.pow(1+rf,t)}
    derived[m.ref].spWeekly=wk;derived[m.ref].spa=S0;
    add('A','pen',`${memberName(m.ref)}: State Pension from ${S0}`,pv,{[m.ref]:1});
  }
  // Defined benefit: member's pension from NRA, plus the spouse's pension after the member's death
  for(const d of S.db){const m=S.members.find(x=>x.ref===d.owner);if(!m)continue;const age=derived[m.ref].age;if(age==null)continue;
    const g=N(d.indexation)/100;const tr=retRate(m);let pv=0;
    for(let t=1;t<=Math.round(N(a.planAge)-age);t++){if(age+t<N(d.nra))continue;pv+=N(d.accrued)*Math.pow(1+g,t)*(1-tr)*surv(m,age,t)/Math.pow(1+rf,t)}
    let spv=0;const sp=adl.find(x=>x.ref!==m.ref);const married=['married','civil'].includes(S.household.relationship);
    if(sp&&married&&N(d.spousePct)>0&&derived[sp.ref]&&derived[sp.ref].age!=null){const sa=derived[sp.ref].age;const str=retRate(sp);
      for(let t=1;t<=Math.round(N(a.planAge)-Math.min(age,sa));t++){spv+=N(d.accrued)*N(d.spousePct)/100*Math.pow(1+g,t)*(1-str)*(1-surv(m,age,t))*surv(sp,sa,t)/Math.pow(1+rf,t)}}
    add('A','pen',`${memberName(m.ref)}: ${d.scheme||'DB pension'}`,pv,{[m.ref]:1},has(d.cetv)?`CETV £${Math.round(N(d.cetv)).toLocaleString('en-GB')}`:'');
    if(sp)add('A','pen',`${memberName(sp.ref)}: spouse's pension from ${d.scheme||'DB scheme'}`,spv,{[sp.ref]:1});
  }

  // Liabilities
  for(const l of S.liabilities)add('L','debt',/^Student|Postgraduate/.test(l.type)?'Student loans':l.type,N(l.balance),ownerAlloc(l.owner));
  const hhAlloc=ownerAlloc('JOINT');
  const jointSurv=t=>{let p=1;for(const m of adl){const ag=derived[m.ref].age;if(ag==null)continue;p*=1-surv(m,ag,t)}return 1-p};
  const catLabel=Object.fromEntries(EXP_CATS);
  const consByCat={};
  // Spending is paid at the start of each year (prudent): year 0 is undiscounted.
  for(const e of S.expenses){const inf=has(e.inflation)?N(e.inflation)/100:cpi;const st=Math.max(0,Math.round(N(e.startIn)));const dur=has(e.duration)?N(e.duration):H-st;let pv=0;
    for(let t=st;t<Math.min(H,st+dur);t++){pv+=N(e.amount)*Math.pow(1+inf,t)/Math.pow(1+rf,t)*(yes(a.survLiab)?jointSurv(t):1)}
    consByCat[e.cat]=(consByCat[e.cat]||0)+pv;}
  for(const [k,v] of Object.entries(consByCat))add('L','cons',catLabel[k]||k,v,hhAlloc);
  for(const g of S.goals){const y=N(g.inYears);add('L','goal',g.label||'Goal',N(g.amount)*Math.pow(1+cpi,y)/Math.pow(1+rf,y),hhAlloc)}
  if(N(S.household.bequestTarget)>0)add('L','goal','Legacy target',N(S.household.bequestTarget)*Math.pow(1+cpi,H)/Math.pow(1+rf,H),hhAlloc);

  // Deferred tax. Pensions: 25% tax-free up to the lump sum allowance, rest at the retirement rate.
  const penByOwner={};for(const ac of S.accounts)if(WGROUP[ac.wrapper]==='pension')penByOwner[ac.owner]=(penByOwner[ac.owner]||0)+N(ac.value);
  for(const ac of S.accounts){const al=ownerAlloc(ac.owner);const mref=Object.keys(al)[0];const m=S.members.find(x=>x.ref===mref);const t=tax[mref];if(!m||!t)continue;
    if(WGROUP[ac.wrapper]==='pension'){const P=penByOwner[ac.owner]||0;const free=Math.min(0.25*P,N(a.lsa));const taxablePct=P>0?(P-free)/P:0.75;add('L','tax','Income tax on pension withdrawals',N(ac.value)*taxablePct*retRate(m),al)}
    else if(CGT_WRAP.includes(ac.wrapper)&&has(ac.baseCost))add('L','tax','CGT on unrealised investment gains',Math.max(0,N(ac.value)-N(ac.baseCost))*t.cgtRate,al);
    else if((ac.wrapper==='Onshore bond'||ac.wrapper==='Offshore bond')&&has(ac.baseCost)){const r=retRate(m)-(ac.wrapper==='Onshore bond'?0.2:0);add('L','tax','Tax on bond gains',Math.max(0,N(ac.value)-N(ac.baseCost))*Math.max(0,r),al)}}
  for(const p of S.property){if(p.type==='Main residence'||!has(p.baseCost))continue;const sh=has(p.share)?N(p.share)/100:1;add('L','tax','CGT on property gains',Math.max(0,N(p.value)-N(p.baseCost))*sh*N(a.cgtH)/100,ownerAlloc(p.owner))}
  for(const o of S.other){if(!has(o.baseCost))continue;const r=yes(o.badr)?N(a.badrRate):N(a.cgtH);add('L','tax','CGT on business and other assets',Math.max(0,N(o.value)-N(o.baseCost))*r/100,ownerAlloc(o.owner))}

  const views=['HH',...S.members.map(m=>m.ref)];
  const val=(l,v)=>v==='HH'?l.value:l.value*(l.alloc[v]||0);
  const groups=['fin','real','hc','pen','debt','cons','goal','tax'];
  const tot={};for(const v of views){const t={A:0,L:0};for(const g of groups)t[g]=0;for(const l of lines){const x=val(l,v);t[l.side]+=x;t[l.group]+=x}tot[v]=t}

  const T=tot.HH;
  const cashLiquid=S.accounts.filter(x=>WGROUP[x.wrapper]==='cash').reduce((s,x)=>s+N(x.value),0);
  const essential=S.expenses.filter(e=>e.cat==='essential'&&N(e.startIn)<=0).reduce((s,e)=>s+N(e.amount),0);
  const debtService=S.liabilities.reduce((s,l)=>s+N(l.payment)*12,0);
  const finAssets=S.accounts.reduce((s,x)=>s+N(x.value),0);
  const realAssets=S.property.reduce((s,p)=>s+N(p.value)*(has(p.share)?N(p.share)/100:1),0)+S.other.reduce((s,o)=>s+N(o.value),0);
  const debt=S.liabilities.reduce((s,l)=>s+N(l.balance),0);
  const essentialPV=lines.filter(l=>l.group==='cons'&&l.label==='Essential').reduce((s,l)=>s+l.value,0);
  const outgo=essential+debtService;
  const kpi={econNW:T.A-T.L,funded:T.L>0?T.A/T.L:Infinity,coreFunded:(T.debt+essentialPV+T.tax)>0?T.A/(T.debt+essentialPV+T.tax):Infinity,
    hcShare:T.A>0?T.hc/T.A:0,cashMonths:outgo>0?cashLiquid/(outgo/12):Infinity,
    tradNW:finAssets+realAssets-debt,finAssets,realAssets,debt,essential,debtService,H,cashLiquid};

  const eqLike={low:.2,medium:.4,high:.6,vhigh:.8};
  let finEq=0,finInv=0;for(const ac of S.accounts){const v=N(ac.value);const s=N(ac.eq)+N(ac.bd)+N(ac.cs)+N(ac.al);if(s>0){finEq+=v*N(ac.eq)/s;finInv+=v}}
  let hcEq=0;for(const m of S.members)hcEq+=derived[m.ref].hc*(eqLike[m.occRisk]??.4);
  kpi.finEqPct=finInv?finEq/finInv:0;kpi.hcEqPct=T.hc?hcEq/T.hc:0;kpi.totalEqPct=(finInv+T.hc)?(finEq+hcEq)/(finInv+T.hc):0;

  // IHT on second death, today's values
  const married=['married','civil'].includes(S.household.relationship);const kids=S.members.some(m=>m.role==='child');
  const pensions=S.accounts.filter(x=>WGROUP[x.wrapper]==='pension').reduce((s,x)=>s+N(x.value),0);
  const bpr=S.other.filter(o=>yes(o.bpr)).reduce((s,o)=>s+N(o.value),0);
  const childWrappers=S.accounts.filter(x=>x.wrapper==='Junior ISA'||x.wrapper==='Child Trust Fund').reduce((s,x)=>s+N(x.value),0);
  const coverInEstate=S.protection.filter(p=>/Life cover|Family income/.test(p.type)&&!yes(p.inTrust)).reduce((s,p)=>s+N(p.sum),0);
  const estate=finAssets-(yes(a.pensionIHT)?0:pensions)+realAssets-debt-bpr-childWrappers+coverInEstate;
  const nrb=N(a.nrb)*(married?2:1)-N(S.household.giftsLast7);
  const homes=S.property.filter(p=>p.type==='Main residence');
  const homeValue=homes.reduce((s,p)=>s+N(p.value)*(has(p.share)?N(p.share)/100:1),0)-S.liabilities.filter(l=>l.type==='Residential mortgage').reduce((s,l)=>s+N(l.balance),0);
  let rnrb=(homes.length&&kids)?N(a.rnrb)*(married?2:1):0;
  rnrb=Math.max(0,rnrb-Math.max(0,(estate-N(a.rnrbTaper))/2));
  rnrb=Math.min(rnrb,Math.max(0,homeValue));
  const iht=Math.max(0,estate-Math.max(0,nrb)-rnrb)*N(a.ihtRate)/100;
  Object.assign(kpi,{estate,iht,nrb:Math.max(0,nrb),rnrb,pensions,coverInEstate,
    uncalled:S.accounts.reduce((s,x)=>s+N(x.uncalled),0),
    lifeCover:S.protection.filter(p=>/Life|Death|Family/.test(p.type)).reduce((s,p)=>s+N(p.sum),0)});
  return {lines,tot,views,val,kpi,tax,derived,H,adl};
}

/* Risk profile: ability from the balance sheet, willingness from the client */
function riskProfile(C){
  const k=C.kpi;const ad=C.adl.filter(isAdult);const lossAdj={sellall:-2,sellsome:-1,hold:0,buy:1};
  const will=ad.map(m=>Math.max(1,Math.min(7,(N(m.riskTol)||4)+(lossAdj[m.lossReaction]||0))));
  const willAvg=will.length?will.reduce((x,y)=>x+y,0)/will.length:4;
  const f=[];const sc=(label,pts,why)=>f.push({label,pts,why});
  sc('Funded status',k.funded>=1.5?2:k.funded>=1.1?1:k.funded>=0.9?0:-2,`Economic assets cover liabilities ${isFinite(k.funded)?k.funded.toFixed(2):'∞'}×`);
  sc('Time horizon',C.H>=15?1:C.H<7?-1:0,`${C.H} years to the planning age`);
  sc('Liquidity',k.cashMonths>=12?1:k.cashMonths<6?-1:0,`${isFinite(k.cashMonths)?k.cashMonths.toFixed(0):'∞'} months of essential outgoings in cash`);
  const risks=ad.map(m=>({low:1,medium:0,high:-1,vhigh:-1}[m.occRisk]??0));const rAvg=risks.length?risks.reduce((x,y)=>x+y,0)/risks.length:0;
  sc('Earnings stability',Math.round(rAvg),'Stability and equity-likeness of household earnings');
  const lev=k.finAssets>0?k.debt/k.finAssets:0;sc('Leverage',lev>0.5?-1:0,`Debt is ${(lev*100).toFixed(0)}% of financial assets`);
  const cap=ad.map(m=>({low:-1,medium:0,high:1}[m.capacity]??0));sc('Adviser capacity-for-loss view',cap.length?Math.round(cap.reduce((x,y)=>x+y,0)/cap.length):0,'From the people records');
  const abilityScore=f.reduce((s,x)=>s+x.pts,0);
  const ability=abilityScore>=3?'Above average':abilityScore<=-1?'Below average':'Average';
  const willingness=willAvg>=5?'Above average':willAvg<3.5?'Below average':'Average';
  const rank={'Below average':0,'Average':1,'Above average':2};
  const overall=rank[ability]<=rank[willingness]?ability:willingness;
  return {f,abilityScore,ability,willingness,overall,willAvg,will};
}

/* Data quality checks */
function checks(){
  const out=[];const push=(lvl,msg,where)=>out.push({lvl,msg,where});
  if(!S.members.length)push('bad','No people recorded.','members');
  const refs=S.members.map(m=>m.ref);
  if(new Set(refs).size!==refs.length)push('bad','Two people share the same reference code.','members');
  if(!S.members.some(m=>m.role==='primary'))push('warn','No primary client is marked.','members');
  for(const m of S.members){
    const nm=memberName(m.ref);
    if(!m.ref)push('bad','A person has no reference code, so nothing can be linked to them.','members');
    if(!m.dob)push('bad',`${nm}: date of birth missing. Age drives every present value.`,'members');
    if(isAdult(m)&&!has(m.niYears))push('warn',`${nm}: NI qualifying years missing. State Pension is estimated as nil.`,'members');
    if(m.residence==='nonuk')push('warn',`${nm}: non-UK resident. UK tax figures are indicative only, and new ISA subscriptions are not allowed.`,'members');
    if(yes(m.usPerson))push('warn',`${nm}: US person. UK funds may be PFICs and ISAs are not tax-free in the US.`,'members');
    if(yes(m.scottish)||S.household.region==='Scotland')push('warn',`${nm}: Scottish taxpayer. Scottish bands are not modelled in this version.`,'members');
    if(m.role==='child'&&ageOf(m)!=null&&ageOf(m)>=18)push('warn',`${nm} is 18 or over. Consider changing role and moving a Junior ISA to an adult ISA.`,'members');
    if(isAdult(m)&&ageOf(m)!=null&&ageOf(m)<18)push('bad',`${nm} is marked as an adult but is under 18.`,'members');
  }
  const okRef=r=>r==='JOINT'||refs.includes(r);
  for(const c of ['income','accounts','db','property','other','liabilities','protection'])S[c].forEach((r,i)=>{if(!okRef(r.owner))push('bad',`${SCHEMA[c].title} #${i+1} is not linked to a person.`,c)});
  S.accounts.forEach(ac=>{const s=N(ac.eq)+N(ac.bd)+N(ac.cs)+N(ac.al);const nm=`${ac.wrapper} (${memberName(ac.owner)})`;
    if(s>0&&Math.abs(s-100)>0.5)push('warn',`${nm}: asset mix adds to ${s}%.`,'accounts');
    if(!has(ac.value))push('warn',`${nm}: value missing.`,'accounts');
    if(ac.owner==='JOINT'&&SINGLE_OWNER.includes(ac.wrapper))push('bad',`${ac.wrapper} cannot be held jointly. Choose one owner.`,'accounts');
    const m=S.members.find(x=>x.ref===ac.owner);
    if(ac.wrapper==='Junior ISA'&&m&&m.role!=='child')push('warn','A Junior ISA is owned by an adult.','accounts');
    if(ac.wrapper==='Lifetime ISA'&&N(ac.contrib)>0){const ag=ageOf(m);if(ag!=null&&ag>=50)push('bad',`${memberName(ac.owner)}: Lifetime ISA contributions are not allowed from age 50.`,'accounts')}
    if(WGROUP[ac.wrapper]==='pension'&&N(ac.contrib)>0&&ac.reliefMethod==='n/a')push('warn',`${nm}: choose how tax relief is given on contributions.`,'accounts');
    if(CGT_WRAP.includes(ac.wrapper)&&!has(ac.baseCost))push('warn',`${nm}: base cost missing, so capital gains are not estimated.`,'accounts');});
  if(!S.expenses.some(e=>e.cat==='essential'))push('bad','No essential spending recorded. Liabilities and liquidity will be understated.','expenses');
  if(S.property.filter(p=>p.type==='Main residence').length>1)push('warn','More than one main residence. Only one can qualify for private residence relief.','property');
  if(S.liabilities.some(l=>/mortgage/i.test(l.type))&&!S.property.length)push('warn','A mortgage is recorded but no property.','liabilities');
  if(!yes(S.household.willsInPlace))push('warn','No wills recorded. Intestacy rules would apply.','household');
  if(!yes(S.household.lpaInPlace))push('warn','No lasting powers of attorney recorded.','household');
  return out;
}

/* =========================================================
   5. ONBOARDING: KYC, AML risk rating and sign-off.
   Rules follow the UK Money Laundering Regulations 2017,
   JMLSG guidance, FCA COBS and Consumer Duty. They are a
   starting framework for the firm's own policy.
   ========================================================= */
function onboarding(C){
  C=C||compute();const c=S.compliance;const R=riskProfile(C);
  const onDate=c.preparedDate||S.household.valuationDate||today();const on=parseDate(onDate);
  const items=[];const add=(stage,lvl,msg,who,where)=>items.push({stage,lvl,msg,who:who||'',where:where||'members'});
  const ad=S.members.filter(isAdult);
  const people=[];let score=0;const factors=[];let mandatoryEDD=false,prohibited=false,seniorNeeded=false;
  const fac=(pts,why,edd)=>{score+=pts;factors.push({pts,why,edd:!!edd});if(edd)mandatoryEDD=true};

  if(!ad.length)add('kyc','bad','No adults recorded, so there is nobody to verify.','', 'members');
  for(const m of ad){const nm=memberName(m.ref);const p={ref:m.ref,name:nm,checks:[]};
    const chk=(key,label,lvl,detail)=>{p.checks.push({key,label,lvl,detail});if(lvl!=='ok')add('kyc',lvl,`${nm}: ${detail}`,m.ref)};
    // Identity details
    const missing=['firstName','lastName','dob','nationality','address','postcode'].filter(k=>!has(m[k]));
    chk('details','Personal details',missing.length?'bad':'ok',missing.length?`missing ${missing.map(k=>fieldLabel('members',k).toLowerCase()).join(', ')}`:'Complete');
    if(has(m.niNumber)&&!validNino(m.niNumber))chk('nino','NI number','bad','NI number format is not valid');
    if(has(m.postcode)&&!validPostcode(m.postcode))chk('postcode','Postcode','warn','postcode format looks wrong');
    if(has(m.email)&&!validEmail(m.email))chk('email','Email','warn','email address looks wrong');
    if(has(m.addressSince)&&on&&daysBetween(parseDate(m.addressSince),on)<3*365.25&&!has(m.prevAddress))chk('prevaddr','Address history','warn','at current address under 3 years; record the previous address');
    // Photo ID
    const exp=parseDate(m.idExpiry);
    if(!m.idMethod||m.idMethod==='none'||!has(m.idNumber))chk('id','Photo ID','bad','photo ID not verified');
    else if(exp&&((on&&exp<on)||(!['approved','conditions'].includes(c.outcome)&&exp<parseDate(today()))))chk('id','Photo ID','bad','photo ID has expired');
    else if(!has(m.idCheckedDate))chk('id','Photo ID','warn','record the date the ID was checked');
    else if(exp&&on&&daysBetween(on,exp)<90)chk('id','Photo ID','warn','photo ID expires within 3 months');
    else chk('id','Photo ID','ok',`${m.idType} checked ${m.idCheckedDate}`);
    // Proof of address
    const pd=parseDate(m.poaDate);
    if(!m.poaType||m.poaType==='none')chk('poa','Proof of address','bad','proof of address not obtained');
    else if(m.poaType!=='electronic'&&!pd)chk('poa','Proof of address','bad','record the date on the proof of address');
    else if(pd&&on&&daysBetween(pd,on)>92)chk('poa','Proof of address','bad','proof of address is more than 3 months old');
    else chk('poa','Proof of address','ok','Within 3 months');
    // Screening
    const sd=parseDate(m.screenDate);
    if(m.sanctions==='confirmed'){prohibited=true;chk('sanctions','Sanctions','bad','confirmed sanctions match. Do not proceed; report to the MLRO.')}
    else if(m.sanctions==='potential')chk('sanctions','Sanctions','bad','potential sanctions match must be resolved before onboarding');
    else if(!m.sanctions||m.sanctions==='none')chk('sanctions','Sanctions','bad','sanctions screening not done');
    else if(!sd)chk('sanctions','Sanctions','warn','record the screening date');
    else if(on&&daysBetween(sd,on)>92)chk('sanctions','Sanctions','bad','screening is more than 3 months old; screen again');
    else chk('sanctions','Sanctions','ok',m.sanctions==='falsepos'?'Match discounted as false positive':'No match');
    if(!m.adverseMedia||m.adverseMedia==='none')chk('media','Adverse media','warn','adverse media not checked');
    else if(m.adverseMedia==='found'){chk('media','Adverse media','warn','adverse media found; assess and record in the EDD findings');fac(2,`${nm}: adverse media found`)}
    else chk('media','Adverse media','ok','Nothing found');
    // PEP
    if(m.pep==='foreign'){fac(3,`${nm}: foreign PEP`,true);seniorNeeded=true}
    else if(m.pep==='domestic'){fac(2,`${nm}: domestic PEP`,true);seniorNeeded=true}
    else if(m.pep==='rca'){fac(2,`${nm}: family member or close associate of a PEP`,true);seniorNeeded=true}
    if(m.pep&&m.pep!=='no'&&!has(m.pepDetail))chk('pepdetail','PEP details','bad','record the PEP role and country');
    chk('pep','PEP status',m.pep&&m.pep!=='no'?'warn':'ok',m.pep&&m.pep!=='no'?'PEP: enhanced due diligence and senior approval required':'Not a PEP');
    // Source of wealth
    if(!has(m.sow))chk('sow','Source of wealth','bad','source of wealth not recorded');
    else if(m.sowEvidence==='none')chk('sow','Source of wealth','warn','no evidence of source of wealth obtained');
    else chk('sow','Source of wealth','ok',`${m.sow} (${m.sowEvidence==='verified'?'verified':'evidence obtained'})`);
    if(['Gift','Other'].includes(m.sow))fac(1,`${nm}: source of wealth is ${m.sow.toLowerCase()}`);
    // Tax status
    if(!yes(m.crsSelfCert))chk('crs','CRS / FATCA','warn','CRS / FATCA self-certification not signed');
    const res=String(m.taxResidencies||'').split(/[;,]/).map(x=>x.trim()).filter(Boolean);
    if(res.some(r=>!/^(uk|united kingdom|great britain|gb)$/i.test(r))&&!has(m.tins))chk('tin','Tax ID','bad','non-UK tax residence recorded without a tax ID number');
    if(m.residence==='nonuk')fac(1,`${nm}: not UK resident`);
    if(yes(m.usPerson)&&!res.some(r=>/^(us|usa|united states)/i.test(r)))chk('fatca','FATCA','bad','US person but the US is not listed as a tax residence');
    // Suitability
    const sm=['riskTol','lossReaction','experience','capacity'].filter(k=>!has(m[k]));
    if(sm.length)add('suitability','bad',`${nm}: missing ${sm.map(k=>fieldLabel('members',k).toLowerCase()).join(', ')}`,m.ref);
    if(m.vulnerability&&m.vulnerability!=='None identified'){
      if(!has(m.supportNeeds))add('suitability','bad',`${nm}: vulnerability recorded (${m.vulnerability}) without support needs`,m.ref);
      if(m.vulnerability==='Health'&&!yes(c.healthConsent))add('documents','bad',`${nm}: health vulnerability recorded without explicit consent to hold health data`,m.ref,'compliance');}
    if(ageOf(m)!=null&&ageOf(m)<18)add('kyc','bad',`${nm}: adult clients must be 18 or over`,m.ref);
    people.push(p);
  }
  // Household risk factors
  if(yes(c.highRiskCountry))fac(3,'Links to a high-risk third country',true);
  if(c.meeting==='remote')fac(1,'Client not met face to face');
  if(yes(c.complexStructure))fac(1,'Trusts, companies or offshore structures');
  if(yes(c.cashIntensive))fac(2,'Cash-intensive business or wealth');
  if(c.fundsRoute==='Third-party payment')fac(2,'Funds paid by a third party');
  if(c.fundsRoute==='Non-UK bank account')fac(1,'Funds from a non-UK bank account');
  if(has(c.fundsCountry)&&!/^(uk|united kingdom|great britain|gb)$/i.test(String(c.fundsCountry).trim()))fac(1,`Funds from ${c.fundsCountry}`);
  if(N(c.expectedInvestment)>=5e6)fac(1,'Expected investment of £5m or more');
  const rating=prohibited?'Prohibited':(mandatoryEDD||score>=4)?'High':score>=2?'Medium':'Low';
  const edd=rating==='High';
  const reviewYears={Low:3,Medium:2,High:1}[rating]||1;
  const approvedOn=['approved','conditions'].includes(c.outcome)&&c.reviewDate?c.reviewDate:'';
  const nextReview=approvedOn?addYears(approvedOn,reviewYears):'';
  // EDD requirements
  if(edd){
    if(!has(c.eddNotes))add('kyc','bad','High AML risk: record enhanced due diligence findings','','compliance');
    for(const m of ad)if(m.sowEvidence!=='verified')add('kyc','bad',`${memberName(m.ref)}: high AML risk needs source of wealth verified, not just obtained`,m.ref);
  }
  if(seniorNeeded&&(!has(c.seniorApprover)||!has(c.seniorApprovalDate)))add('kyc','bad','PEP relationship: senior manager approval required before onboarding','','compliance');
  if(c.meeting==='remote'&&ad.some(m=>m.idMethod==='inperson'))add('kyc','warn','Client recorded as not met, but ID is marked as seen in person','','compliance');
  if(!has(c.purpose))add('kyc','warn','Record the purpose and intended nature of the relationship','','compliance');
  // Suitability (household)
  if(!has(S.household.objectives))add('suitability','bad',"Record the client's objectives",'','household');
  if(R.ability!==R.willingness&&!has(c.riskNote))add('suitability','bad',`Willingness (${R.willingness.toLowerCase()}) differs from ability (${R.ability.toLowerCase()}): record the rationale for the agreed risk level`,'','compliance');
  if(R.will.length>1&&Math.max(...R.will)-Math.min(...R.will)>=2&&!has(c.riskNote))add('suitability','warn','Partners have different risk attitudes: explain how this is reflected','','compliance');
  if(c.categorisation!=='retail')add('suitability','warn','Professional categorisation: keep the assessment and the client\'s written request on file','','compliance');
  if(!yes(c.targetMarket))add('suitability','bad','Target market check not done','','compliance');
  const C2=checks().filter(x=>x.lvl==='bad');
  for(const x of C2)add('discovery','bad',x.msg,'',x.where);
  // Documents
  const docs=[['termsDate','Client agreement'],['feeDate','Fee agreement'],['costsDate','Costs and charges disclosure'],['privacyDate','Privacy notice']];
  const docList=docs.map(([k,l])=>{const ok=has(c[k]);if(!ok)add('documents','bad',`${l} not recorded`,'','compliance');return {label:l,date:c[k]||'',ok}});
  docList.push({label:'Suitability report (issued after advice)',date:c.suitabilityDate||'',ok:has(c.suitabilityDate),optional:true});
  // Sign-off
  const sign=[];const sg=(lvl,msg)=>{sign.push({lvl,msg});add('signoff',lvl,msg,'','compliance')};
  if(!has(c.preparer)||!has(c.preparedDate))sg('bad','Record who prepared the file and when');
  const outcomeSet=['approved','conditions','declined'].includes(c.outcome);
  if(outcomeSet){
    if(!has(c.reviewer)||!has(c.reviewDate))sg('bad','Record the compliance reviewer and review date');
    if(has(c.reviewer)&&has(c.preparer)&&String(c.reviewer).trim().toLowerCase()===String(c.preparer).trim().toLowerCase())sg('bad','The reviewer must be a different person from the preparer (four-eyes check)');
    if(has(c.reviewDate)&&has(c.preparedDate)&&parseDate(c.reviewDate)<parseDate(c.preparedDate))sg('bad','Review date is before the prepared date');
    if(c.outcome==='conditions'&&!has(c.reviewNotes))sg('bad','Record the conditions in the reviewer notes');
  }
  if(prohibited&&['approved','conditions'].includes(c.outcome))sg('bad','Approved despite a confirmed sanctions match');
  const blockers=s=>items.filter(x=>x.stage===s&&x.lvl==='bad');
  const order=['discovery','kyc','suitability','documents'];
  const STAGES=[['discovery','Discovery'],['kyc','KYC and AML'],['suitability','Suitability'],['documents','Disclosures'],['review','Compliance review'],['done','Decision']];
  const preBlock=order.some(s=>blockers(s).length);
  const openAfterApproval=['approved','conditions'].includes(c.outcome)&&(preBlock||blockers('signoff').length);
  let stage;
  if(prohibited)stage='Prohibited';
  else if(c.outcome==='declined')stage='Declined';
  else if(['approved','conditions'].includes(c.outcome)&&!openAfterApproval)stage=c.outcome==='conditions'?'Approved with conditions':'Approved';
  else if(openAfterApproval)stage='Approved with open issues';
  else{const first=order.find(s=>blockers(s).length);stage=first?STAGES.find(x=>x[0]===first)[1]:'Ready for review'}
  const progress=STAGES.map(([k,l])=>{let st;
    if(order.includes(k))st=blockers(k).length?'open':'done';
    else if(k==='review')st=preBlock?'waiting':(outcomeSet?(blockers('signoff').length?'open':'done'):'current');
    else st=outcomeSet&&!preBlock&&!blockers('signoff').length?'done':'waiting';
    return {key:k,label:l,status:st,count:order.includes(k)?blockers(k).length:k==='review'?blockers('signoff').length:0}});
  return {people,items,factors,score,rating,edd,seniorNeeded,prohibited,reviewYears,nextReview,approvedOn,docs:docList,sign,stage,progress,onDate,
    blockerCount:items.filter(x=>x.lvl==='bad').length,warnCount:items.filter(x=>x.lvl==='warn').length,risk:R};
}

return {A,compute,memberTax,riskProfile,checks,onboarding,incomeTax,niCalc,ageOf,memberName,ownerAlloc,isAdult,adults,surv,lifeExp,spa};
}

function fieldLabel(key,k){const f=fieldsOf(SCHEMA[key]).find(x=>x.k===k);return f?f.l:k}

/* Flatten a household into path/value pairs: used for the audit trail diff */
function flatten(s){const out={};
  for(const k of SINGLES)for(const f of fieldsOf(SCHEMA[k]))out[`${k}.${f.k}`]=s[k]?s[k][f.k]:undefined;
  for(const c of COLS)(s[c]||[]).forEach((r,i)=>{for(const f of fieldsOf(SCHEMA[c]))out[`${c}[${i}].${f.k}`]=r[f.k]});
  return out}
function diff(before,after){const a=flatten(before||blank()),b=flatten(after);const keys=new Set([...Object.keys(a),...Object.keys(b)]);const ch=[];
  for(const k of keys){const x=a[k],y=b[k];const ex=x===undefined||x===''||x===false?'':x,ey=y===undefined||y===''||y===false?'':y;if(String(ex)!==String(ey))ch.push({field:k,from:ex,to:ey})}
  const cnt=c=>({b:(before&&before[c]||[]).length,a:(after[c]||[]).length});
  for(const c of COLS){const n=cnt(c);if(n.a!==n.b)ch.push({field:`${c}.count`,from:n.b,to:n.a})}
  return ch}

return {SCHEMA,COLS,SINGLES,YN,ROLES,INCOME_TYPES,HC_TYPES,WRAPPERS,WGROUP,ISA_SUBS,CGT_WRAP,EXP_CATS,
  fieldsOf,fieldLabel,defaults,blank,normalise,sample,bind,coerce,optList,today,N,has,yes,
  validNino,validPostcode,validEmail,parseDate,addYears,flatten,diff,normKey};
});
