/* "How this section is used" panel above each input section; remembers whether it is open (browser storage holds only that preference). */
import { HOW } from '../content/how.js';
import { esc } from '../lib/dom.js';

export const HOW_LS='hwp-how-open';
export function howHTML(key){const w=HOW[key];if(!w)return '';let open=true;try{open=localStorage.getItem(HOW_LS)!=='0'}catch(e){}
  return `<div class="how"><div class="how-h"><b>How this section is used</b><span class="feeds">${w.feeds.map(f=>`<span class="feed">${esc(f)}</span>`).join('')}</span></div><details id="howDetails"${open?' open':''}><summary>What the inputs change</summary><ul>${w.pts.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></details></div>`}
document.addEventListener('toggle',e=>{if(e.target.id==='howDetails')try{localStorage.setItem(HOW_LS,e.target.open?'1':'0')}catch(x){}},true);
