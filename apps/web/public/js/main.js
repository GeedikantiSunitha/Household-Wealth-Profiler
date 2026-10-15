/* Household Wealth Profiler: user interface, start-up.
   Every calculation comes from window.HWP (core.js). Where data is kept:
   - server: the API in server.js (sign-in, encrypted storage, versions, audit trail)
   - cloud:  the Supabase edition (config.js sets supabaseUrl): signs in through cloud.js and calls
             the `api` Edge Function with a bearer token
   - local:  only in the standalone single file (npm run build), which has no server; a page served
             by a server that does not answer stops with an error instead of keeping data here

   Where the rest of the interface lives:
     pages/          one file per screen, the sign-in screens (sign-in.js), and render.js, which draws the screen on show
     components/     form fields, the banner, the how-it-is-used panel, the live-effect panel, the side rail, the top bar
     hooks/          what pages share: the state (state.js), the store (store.js: autosave, edit conflicts, the save
                     status), people and firm look-ups, and io/ (Excel import and export, saving files to the device)
     services/api/   the only code that calls the server (client.js; auth.js for the sign-in)
     lib/            page helpers, number and date formats
     content/        help text, "how this section is used" text, the balance sheet groups
     events/         typing (editing.js), buttons and links (actions.js), the top bar (toolbar.js)
   Pages use components, hooks and services; components use hooks; hooks use services; services use nothing above them. */
import { state, setState } from './hooks/state.js';
import { $, esc } from './lib/dom.js';
import { Store, setRenderer, setGate } from './hooks/store.js';
import { runGate } from './pages/sign-in.js';
import { render } from './pages/render.js';
import { resetUI } from './events/actions.js';
// Loaded for what they do, not for a name: they listen for typing and wire the top-bar buttons
import './events/editing.js';
import './events/toolbar.js';

const H = window.HWP;
setRenderer(() => render());
setGate(runGate);

(async()=>{
  // Sign in (or find the server), then the firm settings: if either fails, the app does not open
  try{await Store.init();await Store.loadFirm()}catch(e){document.body.classList.add('gated');
    $('#main').innerHTML=`<div class="panel gate"><h2>Cannot open the profiler</h2><p>${esc(e.message)}</p>${Store.cloud?'<div class="addrow"><button class="btn" type="button" data-act="signOut">Sign out</button></div>':''}</div>`;return}
  if(Store.mode==='server'){setState(H.blank());state.VIEW='clients'}
  else{setState(Store.loadLocal()||H.sample())}
  resetUI(false);render();
})();
