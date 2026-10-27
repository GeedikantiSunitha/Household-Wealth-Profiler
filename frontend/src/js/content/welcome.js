/* The landing page's text and screenshots (pages/welcome.js shows it): what the product is, for someone
   who is not signed in. Marketing only, no client data. Its Sign in links (data-welcome="signin") open
   the sign-in screen in place, at the same address; its other # links scroll within the page. */
export const WELCOME_HTML = `
<header class="top"><div class="wrap">
  <a class="brand" href="#top"><svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#163A63"/><path d="M8 22V10h3.2l4.8 7.4L20.8 10H24v12h-3v-7l-5 7.3L11 15v7z" fill="#fff"/><rect x="8" y="24.5" width="16" height="1.5" fill="#A8834A"/></svg><div><b>Household Wealth Profiler</b><span>For UK private wealth and advice firms</span></div></a>
  <nav class="nav"><a class="link" href="#flow">How it works</a><a class="link" href="#features">Features</a><a class="link" href="#mortgage">Mortgage structuring</a><a class="link" href="#security">Security</a><a class="btn ghost" href="#sign-in" data-welcome="signin">Sign in</a></nav>
</div></header>

<section class="hero"><div class="wrap">
  <div>
    <div class="eyebrow">Onboarding · Economic balance sheet · Mandate · Workflow</div>
    <h1>The whole client file, worked out from first principles.</h1>
    <p class="lead">One system for a UK wealth firm: KYC and AML onboarding, the CFA economic balance sheet, risk profiling, the investment mandate, the relationship workflow and household mortgage structuring. Every number traceable to its inputs, every step explained for an analyst.</p>
    <div class="cta"><a class="btn primary" href="#sign-in" data-welcome="signin">Sign in to the app</a><a class="btn ghost" href="mailto:sharmaumesh552@gmail.com?subject=Household%20Wealth%20Profiler%20demo">Request a demo</a><small>Indicative figures under 2026/27 rest-of-UK tax rules. Not advice; a suitability report is still required.</small></div>
  </div>
  <img class="shot" src="site/dashboard.png" alt="Household dashboard: economic net worth, funded ratio, risk profile, AML rating, mandate and what to do next" width="1360" height="860">
</div></section>
<div class="proof"><div class="wrap">
  <div><b>5 steps</b><span>Dashboard → Data inputs → Calculation engine → Charts → Reports, in both modules</span></div>
  <div><b>2 modules</b><span>Household profiler and mortgage structuring, one client file</span></div>
  <div><b>UK rules built in</b><span>MLR 2017, JMLSG, FCA COBS and Consumer Duty as the starting framework</span></div>
  <div><b>Encrypted at rest</b><span>Every record sealed with AES-256-GCM, versioned and audited</span></div>
</div></div>

<section id="flow"><div class="wrap">
  <div class="sec-h"><h2>One five-step flow, so anyone can follow where a number came from</h2><p>Both modules use the same shape. Inputs sit in one place, the engine shows its working with the client's own figures, the charts read from the engine and the reports print what the client sees.</p></div>
  <div class="flow">
    <div><b>Dashboard</b><p>Economic net worth, funded ratio, risk profile, AML rating, mandate status, what to do next and my open tasks.</p></div>
    <div><b>Data inputs</b><p>Tabbed pages for the client and their wealth, onboarding, the relationship and the mandate. Excel template and import for new clients.</p></div>
    <div><b>Calculation engine</b><p>Assumptions and a step-by-step trace: human capital, pension rights, deferred tax, funded ratio, risk scoring.</p></div>
    <div><b>Charts and analysis</b><p>Balance sheet, life-event scenarios, tax, risk, mandate drift, fund performance against benchmark.</p></div>
    <div><b>Reports</b><p>Client report, KYC status, data checks, reviews due and the audit trail, ready to print or save as PDF.</p></div>
  </div>
</div></section>

<section class="alt" id="features"><div class="wrap">
  <div class="sec-h"><h2>Built around how a UK private wealth firm actually works</h2><p>From the first meeting to the annual review, with the compliance evidence produced as a by-product of doing the work.</p></div>
  <div class="grid">
    <div class="card"><span class="tag">Onboarding</span><h3>KYC, AML and suitability</h3><p>Identity, proof of address, screening and source of wealth for each adult. Risk rating with a review cycle, enhanced due diligence triggers and a four-eyes sign-off.</p><ul><li>Scored risk questionnaire for every adult</li><li>Letters of authority generated, tracked and chased</li><li>Document register with expiry dates</li></ul></div>
    <div class="card"><span class="tag">Balance sheet</span><h3>The CFA economic balance sheet</h3><p>Human capital, pension rights, property, portfolios and debts against future spending, goals and deferred tax, all in today's money.</p><ul><li>Funded ratio and what moves it</li><li>UK income tax, NI, CGT and IHT engine</li><li>Life-event scenarios: death, separation, care, redundancy, market falls</li></ul></div>
    <div class="card"><span class="tag">Mandate</span><h3>Risk profile and model portfolios</h3><p>Ability to take risk scored from the balance sheet, willingness from the questionnaire; the lower of the two sets the level.</p><ul><li>Risk-rated model portfolios across eight asset classes</li><li>Mandate drift against target with tolerance bands</li><li>Service tier, fee basis and the ongoing fee on the client report</li></ul></div>
    <div class="card"><span class="tag">Relationship</span><h3>Tasks, instructions and reviews</h3><p>Standard instruction checklists create the task sequence, assigned by role and dated. Every dated obligation lands in Reviews due.</p><ul><li>ISA, pension transfer, fund switch, withdrawal, annual review</li><li>Contact log, notes, complaints and issues register</li><li>Calendar export for reviews and tasks</li></ul></div>
    <div class="card"><span class="tag">Communications</span><h3>Templated emails and requests</h3><p>Welcome letters, document requests, letter-of-authority covers, review invitations and fee statements written from the file, then sent or queued.</p><ul><li>Email through Postmark or Resend when connected</li><li>E-signature and electronic identity-check requests</li><li>Everything logged to the contact log and the outbox</li></ul></div>
    <div class="card"><span class="tag">Firm</span><h3>Firm-wide boards and settings</h3><p>All households, tasks by person, reviews due, issues and server logs in one place, with shared firm settings.</p><ul><li>Team, providers, fund library with price history</li><li>Default assumptions copied into every new client</li><li>Full audit trail of every change, by whom and when</li></ul></div>
  </div>
</div></section>

<section id="mortgage"><div class="wrap split">
  <div><span class="tag">Second module</span><h2>Household mortgage structuring, modelled like a professional debt desk</h2><p>Compare repayment structures, fixed against variable terms, first-time buyer routes and green deals for the same household, with affordability stress and a break-even on every rate choice. UK and Ireland in full, with a reference guide to the rest of Europe and Switzerland.</p>
    <ul><li>Capital repayment, interest-only with a repayment vehicle, part-and-part, offset, retirement interest-only and more</li><li>Rate strategy: 2, 5 and 10-year views with base, fall and rise paths</li><li>Deposit tiers, Lifetime ISA and stamp duty for first-time buyers</li><li>Energy rating, green discounts and retrofit economics</li></ul></div>
  <img src="site/mortgage.png" alt="Mortgage structuring dashboard comparing repayment structures and rate strategy" width="1360" height="860" loading="lazy">
</div></section>

<section class="alt"><div class="wrap split">
  <img src="site/comms.png" alt="Communications page with a templated email filled from the client file" width="1360" height="860" loading="lazy">
  <div><span class="tag">Day to day</span><h2>Less re-typing, more evidence</h2><p>The file writes the letters. Pick a template and the client names, adviser, firm details, missing documents and review dates are already in place. Send through the firm's email service, or open it in your own mail program and the message is still logged.</p>
    <ul><li>Letters of authority move status automatically when emailed</li><li>Queued items appear in Reviews due until they are sent</li><li>Provider slots for Signable, DocuSign, SmartSearch and Creditsafe: choose the provider, add the key, nothing else changes</li></ul></div>
</div></section>

<section class="trust" id="security"><div class="wrap">
  <div class="sec-h"><h2>Security and control a compliance officer will recognise</h2><p>Client data is sensitive. The product is built so the firm keeps control of where it lives and who can see it.</p></div>
  <div class="grid">
    <div class="card"><h3>Encrypted and append-only</h3><p>Every record is sealed with AES-256-GCM before it is stored. Nothing is overwritten: each save is a new version, and there is no delete.</p></div>
    <div class="card"><h3>Audited</h3><p>Field-level audit trail of every change, by whom and when, for each household and for firm settings. Server log of requests and errors.</p></div>
    <div class="card"><h3>Hardened</h3><p>Sign-in lockout after repeated failures, strict content security policy, cross-site request protection, no runtime dependencies to patch.</p></div>
    <div class="card"><h3>Your choice of hosting</h3><p>Run it on your own server or private cloud, on Vercel with a UK-region database, or as a multi-firm edition on Supabase with two-step sign-in.</p></div>
    <div class="card"><h3>Everything in one file</h3><p>Export any household to Excel or JSON at any time. Import a completed template to load a new client in one step.</p></div>
    <div class="card"><h3>Open to your tools</h3><p>Email, e-signature, identity checks, calendars and document stores connect through provider slots and environment settings, never through keys stored with client data.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <div class="sec-h"><h2>Getting a firm started</h2></div>
  <div class="steps">
    <div class="card"><b>1 · Set up the firm</b><p>Firm details for letters, the team and their roles, providers, model portfolios, default assumptions and the integrations you use.</p></div>
    <div class="card"><b>2 · Load the first clients</b><p>Download the Excel template, fill it in with the client, import it. Or start blank and work through the tabbed inputs with the client in the room.</p></div>
    <div class="card"><b>3 · Work the file</b><p>Clear the onboarding blockers, agree the mandate, start the instructions, send the letters. Reviews due and the firm boards keep everyone on track.</p></div>
  </div>
</div></section>

<div class="cta-band"><div class="wrap">
  <h2>See it with a real household</h2>
  <p>Sign in with the demo account you were given, or ask for a walk-through.</p>
  <a class="btn ink" href="#sign-in" data-welcome="signin">Sign in</a>&nbsp;&nbsp;<a class="btn line" href="mailto:sharmaumesh552@gmail.com?subject=Household%20Wealth%20Profiler%20demo">Request a demo</a>
</div></div>

<footer><div class="wrap">
  <p>Figures are indicative and use 2026/27 rest-of-UK tax rules. They are not advice and do not replace a suitability report. Onboarding rules follow MLR 2017, JMLSG and FCA COBS as a starting framework: the firm's MLRO must approve them before use.</p>
  <p>© 2026 Household Wealth Profiler</p>
</div></footer>
`;
