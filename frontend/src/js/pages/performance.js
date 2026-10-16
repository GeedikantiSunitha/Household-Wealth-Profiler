/* Fund performance: growth of 10,000, cumulative, annualised and discrete returns for the chosen funds and benchmarks, with the past-performance warning. */
import { Store } from '../hooks/store.js';
import { bannerHTML } from '../components/banner.js';
import { esc } from '../lib/dom.js';
import { fmtYM, gbp } from '../lib/format.js';

const H = window.HWP; const { has, yes } = H;

export const PERF={sel:new Set(),period:'5y',touched:false};
export const PERF_COLORS=['--viz-1','--viz-2','--viz-3','--viz-4'];
export function renderPerf(){
  const funds=(Store.firm.settings.funds||[]).map(f=>({...f,series:H.seriesDecode(f.prices)})).filter(f=>f.name&&f.series.length>1);
  let h=`<div class="sec-head"><div><h2>Fund performance</h2><p>Past performance of the firm’s funds and benchmarks, from the price history in the fund library. Choose up to four funds and a benchmark.</p></div>${Store.mode==='server'||true?'<div class="addrow"><button class="btn" type="button" data-act="firmSettings">Manage fund library</button></div>':''}</div>`+bannerHTML(false);
  if(!funds.length)return h+`<div class="empty">No price history yet. Add funds under Firm settings › Fund library, then import a CSV of prices for each (from FT, Trustnet, Morningstar, the provider’s factsheet or Yahoo).</div>`;
  if(!PERF.touched&&!PERF.sel.size){funds.filter(f=>!yes(f.isBenchmark)).slice(0,3).forEach(f=>PERF.sel.add(f.name));const b=funds.find(f=>yes(f.isBenchmark));if(b)PERF.sel.add(b.name)}
  for(const n of [...PERF.sel])if(!funds.some(f=>f.name===n))PERF.sel.delete(n);
  const chosenF=funds.filter(f=>PERF.sel.has(f.name)&&!yes(f.isBenchmark)).slice(0,4);const chosenB=funds.find(f=>PERF.sel.has(f.name)&&yes(f.isBenchmark));
  const chosen=[...chosenF.map((f,i)=>({...f,color:`var(${PERF_COLORS[i]})`})),...(chosenB?[{...chosenB,color:'var(--viz-bench)'}]:[])];
  h+=`<div class="perf-bar"><div class="perf-pick">${funds.map(f=>{const on=PERF.sel.has(f.name);const idx=chosen.findIndex(c=>c.name===f.name);return `<button type="button" class="chip${on?' on':''}" data-act="perfPick" data-name="${esc(f.name)}" aria-pressed="${on}">${on&&idx>=0?`<i style="background:${chosen[idx].color}"></i>`:''}${esc(f.name)}${yes(f.isBenchmark)?' <span class="muted">benchmark</span>':''}</button>`}).join('')}</div>
    <div class="seg" role="group" aria-label="Period">${[['1y','1 year'],['3y','3 years'],['5y','5 years'],['10y','10 years'],['max','Max']].map(([v,l])=>`<button type="button" data-act="perfPeriod" data-v="${v}" aria-pressed="${PERF.period===v}">${l}</button>`).join('')}</div></div>`;
  if(!chosen.length)return h+'<div class="empty">Choose at least one fund above.</div>';
  const months={'1y':12,'3y':36,'5y':60,'10y':120,max:0}[PERF.period];
  const G=H.growthCompare(chosen,months);
  if(!G)return h+'<div class="empty">The chosen funds have no months of history in common.</div>';
  h+=`<div class="panel"><h3>Growth of £10,000, ${fmtYM(G.start)} to ${fmtYM(G.end)}</h3>${perfChart(G)}</div>`;
  const P=chosen.map(f=>({f,p:H.fundPerf(f.series)}));const pc=v=>v==null?'–':(v>=0?'+':'−')+Math.abs(v*100).toFixed(1)+'%';
  h+=`<div class="panel"><h3>Returns</h3><div class="tbl-wrap"><table><thead><tr><th>Fund</th><th class="n">1 year</th><th class="n">3 years</th><th class="n">5 years</th><th class="n">5 yrs a year</th><th class="n">10 yrs a year</th><th class="n">Volatility</th><th class="n">Worst fall</th><th class="n">Ongoing charge</th><th class="n">Data to</th></tr></thead><tbody>
    ${P.map(({f,p})=>`<tr><td><span class="key" style="background:${f.color}"></span>${esc(f.name)}</td><td class="n">${pc(p.cum['1y'])}</td><td class="n">${pc(p.cum['3y'])}</td><td class="n">${pc(p.cum['5y'])}</td><td class="n">${pc(p.ann['5y'])}</td><td class="n">${pc(p.ann['10y'])}</td><td class="n">${p.vol==null?'–':(p.vol*100).toFixed(1)+'%'}</td><td class="n">${pc(p.maxDD)}</td><td class="n">${has(f.ocf)?f.ocf+'%':'–'}</td><td class="n">${fmtYM(p.last)}</td></tr>`).join('')}</tbody></table></div></div>`;
  const ref=P[0].p.discrete;
  h+=`<div class="panel"><h3>Discrete 12-month performance</h3><div class="tbl-wrap"><table><thead><tr><th>Fund</th>${ref.map(d=>`<th class="n">${fmtYM(d.start)} – ${fmtYM(d.end)}</th>`).join('')}</tr></thead><tbody>
    ${P.map(({f,p})=>`<tr><td><span class="key" style="background:${f.color}"></span>${esc(f.name)}</td>${p.discrete.map(d=>`<td class="n">${pc(d.r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note"><b>Past performance is not a reliable indicator of future results.</b> The value of investments and the income from them can fall as well as rise, and investors may get back less than they invested. Figures are in pounds sterling, based on month-end prices${chosen.some(f=>f.source)?': '+esc([...new Set(chosen.map(f=>f.source).filter(Boolean))].join('; ')):''}. They show price changes of the units or index supplied; use accumulation units or total-return indices so that reinvested income is included. They do not deduct adviser or platform charges. Volatility is the annualised standard deviation of monthly returns.</p></div>`;
  return h}
export function perfChart(G){
  const W=820,Hh=320,ml=58,mr=16,mt=14,mb=30;const pw=W-ml-mr,ph=Hh-mt-mb;
  const all=G.lines.flatMap(l=>l.values);let lo=Math.min(10000,...all),hi=Math.max(10000,...all);const pad=(hi-lo)*0.06||500;lo-=pad;hi+=pad;
  const step=[500,1000,2000,2500,5000,10000,20000,50000].find(s=>(hi-lo)/s<=6)||100000;const t0=Math.ceil(lo/step)*step;const ticks=[];for(let v=t0;v<=hi;v+=step)ticks.push(v);
  const n=G.dates.length-1;const x=i=>ml+pw*(n?i/n:0);const y=v=>mt+ph*(1-(v-lo)/(hi-lo));
  const jan=G.dates.map((d,i)=>[d,i]).filter(([d])=>d.endsWith('-01'));const years=(!jan.length||jan[0][1]>=6)?[[G.dates[0],0],...jan]:jan;const every=Math.max(1,Math.ceil(years.length/8));
  let svg=`<svg class="perf-svg" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Growth of £10,000 for the selected funds">`;
  svg+=ticks.map(v=>`<line x1="${ml}" x2="${W-mr}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${ml-8}" y="${y(v)+4}" class="ax" text-anchor="end">£${(v/1000).toFixed(v%1000?1:0)}k</text>`).join('');
  svg+=`<line x1="${ml}" x2="${W-mr}" y1="${y(10000)}" y2="${y(10000)}" class="base"/>`;
  svg+=years.filter((_,k)=>k%every===0).map(([d,i])=>`<text x="${x(i)}" y="${Hh-8}" class="ax" text-anchor="middle">${i===0&&!d.endsWith('-01')?fmtYM(d):d.slice(0,4)}</text>`).join('');
  svg+=G.lines.map(l=>`<path d="${l.values.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1)).join('')}" fill="none" stroke="${l.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  svg+=`<line class="xh" x1="0" x2="0" y1="${mt}" y2="${mt+ph}" visibility="hidden"/>`+G.lines.map((l,k)=>`<circle class="xd" data-k="${k}" r="4" fill="${l.color}" visibility="hidden"/>`).join('');
  svg+=`<rect class="hit" x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="transparent"/></svg>`;
  PERF.g={G,x,y,n,ml,pw};
  return `<div class="perf-wrap">${svg}<div class="perf-tip" hidden></div></div><div class="perf-ends">${G.lines.map(l=>`<span><i style="background:${l.color}"></i>${esc(l.name)}${yes(l.isBenchmark)?' (benchmark)':''}: <b>${gbp(l.values[l.values.length-1])}</b></span>`).join('')}</div>`}
export function bindPerfChart(){const wrap=document.querySelector('.perf-wrap');if(!wrap||!PERF.g)return;const {G,x,y,n,ml,pw}=PERF.g;const svg=wrap.querySelector('svg');const tip=wrap.querySelector('.perf-tip');
  const xh=svg.querySelector('.xh'),dots=[...svg.querySelectorAll('.xd')];
  const show=ev=>{const r=svg.getBoundingClientRect();const sx=(ev.clientX-r.left)*(820/r.width);const i=Math.max(0,Math.min(n,Math.round((sx-ml)/pw*n)));
    xh.setAttribute('x1',x(i));xh.setAttribute('x2',x(i));xh.setAttribute('visibility','visible');
    dots.forEach((d,k)=>{d.setAttribute('cx',x(i));d.setAttribute('cy',y(G.lines[k].values[i]));d.setAttribute('visibility','visible')});
    tip.replaceChildren();const hd=document.createElement('b');hd.textContent=fmtYM(G.dates[i]);tip.append(hd);
    G.lines.map((l,k)=>({l,v:l.values[i]})).sort((a,b)=>b.v-a.v).forEach(({l,v})=>{const row=document.createElement('div');const key=document.createElement('i');key.style.background=l.color;const nm=document.createElement('span');nm.textContent=l.name;const val=document.createElement('b');val.textContent=gbp(v);row.append(key,nm,val);tip.append(row)});
    tip.hidden=false;const px=x(i)/820*r.width;tip.style.left=(px>r.width*0.6?px-tip.offsetWidth-12:px+12)+'px'};
  const hide=()=>{tip.hidden=true;xh.setAttribute('visibility','hidden');dots.forEach(d=>d.setAttribute('visibility','hidden'))};
  svg.querySelector('.hit').addEventListener('pointermove',show);svg.querySelector('.hit').addEventListener('pointerleave',hide)}
