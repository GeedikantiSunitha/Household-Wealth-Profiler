/* Form building blocks: field inputs with their tooltips and checks, field groups, owner choices and the one-line summary shown on each card. */
import { FIELD_HELP, GROUP_HELP } from '../content/help.js';
import { Store } from '../hooks/store.js';
import { esc } from '../lib/dom.js';
import { FIRM_KEYS, providerOptions, teamOptions } from '../hooks/firm.js';
import { fmtDate, gbp, fmtYM } from '../lib/format.js';
import { isAdult, memberName } from '../hooks/people.js';
import { state } from '../hooks/state.js';

const H = window.HWP; const { SCHEMA, YN, ROLES, EXP_CATS, optList, N, has, yes } = H;

export const tipBtn=(label,text,cls='')=>text?`<button type="button" class="tip ${cls}" aria-label="About ${esc(label)}" data-tip="${esc(text)}">i</button>`:'';
export function ownerOptions(withJoint){let o=withJoint?[['JOINT','Joint (adults equally)']]:[];return o.concat(state.S.members.map(m=>[m.ref,`${m.ref} · ${m.firstName||''} ${m.lastName||''}`.trim()]))}
export const VALIDATE={niNumber:v=>!v||H.validNino(v)?'':'Not a valid NI number',postcode:v=>!v||H.validPostcode(v)?'':'Check the postcode format',email:v=>!v||H.validEmail(v)?'':'Check the email address'};
export function fieldHTML(col,idx,f,val){
  const id=`f-${col}-${idx}-${f.k}`;const data=`data-col="${col}" data-idx="${idx}" data-k="${f.k}"${FIRM_KEYS.has(col)?' data-scope="firm"':''}${Store.locked(col,f.k,FIRM_KEYS.has(col)?'firm':'')?' disabled aria-disabled="true"':''}`;
  const vmsg=VALIDATE[f.k]?VALIDATE[f.k](val):'';
  const hint=vmsg?`<span class="hint err" id="${id}-h">${esc(vmsg)}</span>`:f.h?`<span class="hint" id="${id}-h">${esc(f.h)}</span>`:'';
  const aria=(vmsg||f.h?` aria-describedby="${id}-h"`:'')+(vmsg?' aria-invalid="true"':'');
  const tip=tipBtn(f.l,FIELD_HELP[`${col}.${f.k}`]||f.h);
  if(f.t===YN)return `<div class="f chk"><input type="checkbox" id="${id}" ${data} ${yes(val)?'checked':''}><span class="lab"><label for="${id}">${esc(f.l)}</label>${tip}</span></div>`;
  let ctl;
  if(f.t==='sel'||f.t==='member'||f.t==='owner'||f.t==='model'||f.t==='team'||f.t==='provider'){const opts=f.t==='sel'?optList(f.o):f.t==='model'?state.S.models.map(m=>[m.name,m.name]):f.t==='team'?teamOptions(val):f.t==='provider'?providerOptions(val):ownerOptions(f.t==='owner');const known=opts.some(o=>String(o[0])===String(val));
    ctl=`<select id="${id}" ${data}${aria}>${(f.t!=='sel'||!known)?`<option value="">${f.t==='sel'?'Select…':f.t==='model'?'Select model…':f.t==='team'?'Unassigned':f.t==='provider'?'Select provider…':'Select person…'}</option>`:''}${opts.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(val)?'selected':''}>${esc(l)}</option>`).join('')}</select>`}
  else if(f.t==='area')ctl=`<textarea id="${id}" ${data}${aria}>${esc(val)}</textarea>`;
  else if(f.t==='date')ctl=`<input type="date" id="${id}" ${data}${aria} value="${esc(val)}">`;
  else if(f.t==='num'||f.t==='pct'||f.t==='int')ctl=`<input type="number" inputmode="decimal" step="${f.t==='int'?1:'any'}" id="${id}" ${data}${aria} value="${esc(val)}">`;
  else ctl=`<input type="text" id="${id}" ${data}${aria} value="${esc(val)}" autocomplete="off">`;
  return `<div class="f${f.w?' wide':''}"><span class="lab"><label for="${id}">${esc(f.l)}</label>${tip}</span>${ctl}${hint}</div>`;
}
export function fieldsBlock(key,idx,rec){const s=SCHEMA[key];
  if(s.groups)return s.groups.filter(g=>!(g.adultOnly&&key==='members'&&!isAdult(rec))).map(g=>`<div class="grp"><h4>${esc(g.t)}${tipBtn(g.t,GROUP_HELP[g.t])}</h4><div class="fields">${g.fields.map(f=>fieldHTML(key,idx,f,rec[f.k])).join('')}</div></div>`).join('');
  return `<div class="fields">${s.fields.filter(f=>f.t!=='series').map(f=>fieldHTML(key,idx,f,rec[f.k])).join('')}</div>`}
export function summary(key,r){
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
    case 'actions':return [r.description||'Task',`${r.owner||'Unassigned'}${r.due?' · due '+fmtDate(r.due):''}${r.priority==='High'?' · high priority':''}`,r.status||''];
    case 'rtq':{const sc=H.rtqScore(r);return [r.owner?memberName(r.owner):'Choose the client',`${sc.answered} of ${sc.of} answered${r.completedOn?' · '+fmtDate(r.completedOn):''}`,sc.complete?`Risk ${sc.atr.band} · capacity ${sc.cfl.level}`:'Incomplete']}
    case 'loas':return [`${r.provider||'Provider'}${r.policyRef?' · '+r.policyRef:''}`,`${r.owner?memberName(r.owner):'No client'} · ${r.planType||''}${r.sentOn?' · sent '+fmtDate(r.sentOn):''}`,r.status||''];
    case 'funds':{const a=H.seriesDecode(r.prices);return [r.name||'Fund',`${r.isBenchmark?'Benchmark':((H.ASSET_CLASSES.find(x=>x[0]===r.assetClass)||[0,''])[1])}${r.isin?' · '+r.isin:''}${r.ticker?' · '+r.ticker:''}`,a.length?`${a.length} months to ${fmtYM(a[a.length-1].d)}`:'No prices']}
    case 'team':return [r.name||'Team member',`${r.role||''}${r.email?' · '+r.email:''}`,yes(r.active)?'':'Inactive'];
    case 'providers':return [r.name||'Provider',`${r.kind||''}${r.email?' · '+r.email:r.address?' · postal':''}`,r.address||r.email||r.portal?'':'Add contact details'];
    case 'complaints':return [(r.summary||'Complaint').slice(0,70),`received ${fmtDate(r.received)} · ${r.stage||''}`,r.outcome||''];
  }return ['','',''];
}
