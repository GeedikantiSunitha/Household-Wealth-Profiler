/* The banner above a screen: the sample-household notice and the current message (state.banner).
   state.banner.text is shown as text (escaped); state.banner.html is the app's own markup, and any
   server or file text put into it must go through esc() first. */
import { state } from '../state.js';
import { esc } from '../lib/dom.js';

export function bannerHTML(household=true){let h='';
  if(household&&state.S&&state.S.isSample)h+=`<div class="banner sample"><div><b>Sample household.</b> These are made-up figures to show how the model works. Replace them with client data, import a file, or start blank.</div></div>`;
  if(state.banner)h+=`<div class="banner ${state.banner.cls||''}"><div>${state.banner.text != null ? esc(state.banner.text) : state.banner.html}</div>${state.banner.sticky?'':'<button class="btn ghost x" type="button" data-act="closeBanner" aria-label="Dismiss">✕</button>'}</div>`;
  return h}
