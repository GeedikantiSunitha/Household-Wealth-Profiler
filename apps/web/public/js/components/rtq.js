/* Risk questionnaire panel: the scored answers and the result shown in the questionnaire section. */
import { esc } from '../lib/dom.js';
import { isAdult, memberName } from '../lib/people.js';
import { state } from '../state.js';

const H = window.HWP;

export const LOSS_LABEL={sellall:'Sell everything (−2)',sellsome:'Sell some (−1)',hold:'Hold (0)',buy:'Invest more (+1)'};
export function rtqPanel(){const ad=state.S.members.filter(isAdult);if(!ad.length)return '<div class="empty">Add the adults under People first.</div>';
  let h='<div class="rtq-grid">';
  for(const m of ad){const q=state.S.rtq.find(x=>x.owner===m.ref);const nm=memberName(m.ref);
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
