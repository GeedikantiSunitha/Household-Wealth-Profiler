/* "How this section is used": for each input section, the outputs it feeds and what its fields
   change. Shown above the form by howHTML() in main.js. Text only: no logic.
     HOW  section id -> { feeds: [output names], pts: [explanations] } */

export const HOW={
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
