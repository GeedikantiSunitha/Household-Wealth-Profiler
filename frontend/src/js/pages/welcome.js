/* The landing page: the app's opening screen for someone who is not signed in (the app's own sign-in;
   with HTTP Basic the browser asks for the password and the app opens as before). It sits in front of
   the app at the same address: the top bar, side rail and footer are hidden while it shows (welcome.css).
     welcome()   shows it; resolves when Sign in is chosen, with the page taken away again */
import { WELCOME_HTML } from '../content/welcome.js';
import { shown } from '../lib/dom.js';

export function welcome() {
  document.body.classList.add('welcome');
  const el = document.createElement('div');
  el.id = 'welcome';
  el.innerHTML = WELCOME_HTML;
  document.body.prepend(el);
  shown();
  window.scrollTo(0, 0);
  return new Promise(ok => {
    el.onclick = e => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return; // the demo request is an ordinary mail link
      e.preventDefault(); // nothing here changes the address: the app reads its fragment for the links in emails
      if (a.dataset.welcome === 'signin') {
        el.remove(); document.body.classList.remove('welcome'); window.scrollTo(0, 0);
        ok();
        return;
      }
      const id = a.getAttribute('href').slice(1);
      const target = id && el.querySelector('#' + CSS.escape(id));
      (target || el).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
}
