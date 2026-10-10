/* Household Wealth Profiler: user interface, start-up.
   Every calculation comes from window.HWP (core.js). Where data is kept:
   - server: the API in server.js (sign-in, encrypted storage, versions, audit trail)
   - cloud:  the Supabase edition (config.js sets supabaseUrl): signs in through cloud.js and calls
             the `api` Edge Function with a bearer token
   - local:  only in the standalone single file (npm run build), which has no server; a page served
             by a server that does not answer stops with an error instead of keeping data here

   Where the rest of the interface lives:
     state.js        shared state (the open household, the screen on show, open cards, the banner)
     api/store.js    saving: the server connection, autosave, edit conflicts, the save status
     lib/            page helpers, number and date formats, people in the household
     content/        help text and "how this section is used" text
     components/     form fields, the banner, the how-it-is-used panel, the live-effect panel
     views/          one file per screen; views/render.js draws the screen on show
     events/         typing (editing.js), buttons and links (actions.js), the top bar (toolbar.js)
     io/             Excel import and export, saving files to the device */
import { state, setState } from './state.js';
import { $, esc } from './lib/dom.js';
import { Store, setRenderer } from './api/store.js';
import { render } from './views/render.js';
import { resetUI } from './events/actions.js';
import { initDownloads } from './io/download.js';
// Loaded for what they do, not for a name: they listen for typing and wire the top-bar buttons
import './events/editing.js';
import './events/toolbar.js';

const H = window.HWP;
setRenderer(() => render());

(async()=>{
  initDownloads();
  try{await Store.init()}catch(e){document.body.classList.add('gated');
    $('#main').innerHTML=`<div class="panel gate"><h2>Cannot open the profiler</h2><p>${esc(e.message)}</p>${Store.cloud?'<div class="addrow"><button class="btn" type="button" data-act="signOut">Sign out</button></div>':''}</div>`;return}
  if(Store.mode==='server'){setState(H.blank());state.VIEW='clients'}
  else{setState(Store.loadLocal()||H.sample())}
  resetUI(false);render();
})();
