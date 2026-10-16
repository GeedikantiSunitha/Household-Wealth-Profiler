/* Letters of authority: the letter to a provider, built from the household's record, ready to print. */
import { Store } from '../hooks/store.js';
import { esc } from '../lib/dom.js';
import { fmtDate } from '../lib/format.js';
import { state } from '../hooks/state.js';

const H = window.HWP; const { has, yes } = H;

export const LOA_REQ=[['reqValue','the current value of the plan'],['reqTransfer','the current transfer value and any exit charges or penalties'],['reqFunds','the funds held, with unit holdings and prices'],['reqCharges','all charges: product, fund and any adviser charges currently paid'],['reqContrib','the contribution history, including employer contributions'],['reqGuarantees','any guarantees or safeguarded benefits, such as guaranteed annuity rates, guaranteed minimum pension or protected tax-free cash'],['reqDeath','the death benefits and any nomination of beneficiaries'],['reqRetire','the selected retirement date and the options available at retirement']];
export function renderLetter(){const l=state.S.loas[state.LOA_IDX];if(!l)return '<div class="empty">Letter not found.</div>';const F=Store.firm.settings.firm;
  const prov=(Store.firm.settings.providers||[]).find(p=>p.name===l.provider)||{};const m=state.S.members.find(x=>x.ref===l.owner)||{};
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
