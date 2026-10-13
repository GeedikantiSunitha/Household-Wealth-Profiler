/* Top bar: who is signed in, the save status and which buttons apply on this screen. */
import { Store, saveStatus } from '../api/store.js';
import { $, esc } from '../lib/dom.js';
import { state } from '../state.js';
import { FIRM_VIEWS } from './nav.js';

export function renderTopbar(){
  const server=Store.mode==='server';const inHH=!FIRM_VIEWS.has(state.VIEW);
  $('#btnClients').hidden=!server||!inHH;
  for(const id of ['#btnImport','#btnExport','#btnJson'])$(id).hidden=!inHH;
  $('#btnImport').hidden=!inHH||!Store.canEditHousehold(); // an Excel import changes the file
  $('#resetWrap').hidden=server||!inHH;
  $('#who').innerHTML=Store.session?`<details class="menu"><summary><b>${esc(Store.firmName||'')}</b>${Store.firmName?' · ':''}${esc(Store.name||Store.user)}${Store.roleLabel()?' · '+esc(Store.roleLabel()):''}</summary><div class="menu-items">
      <button class="btn ghost" type="button" data-act="account">Account security</button><button class="btn ghost" type="button" data-act="switchFirm">Switch firm</button><button class="btn ghost" type="button" data-act="signOut">Sign out</button></div></details>`:server?`Signed in as <b>${esc(Store.user)}</b>${Store.cloud?' <button class="btn ghost" type="button" data-act="signOut">Sign out</button>':''}`:`<label for="whoIn">Working as</label><input id="whoIn" value="${esc(Store.user)}" placeholder="Your name">`;
  saveStatus();
}
