/* Small page helpers used by every screen. */

// The first element matching a CSS selector
export const $ = s => document.querySelector(s);

// The app knows what to show: take away the start-up class that keeps the page hidden (styles.css, start-up)
export const shown = () => document.documentElement.classList.remove('booting');

// Text made safe to put inside HTML (every screen builds HTML from strings)
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A short message at the bottom of the page for 2.8 seconds
export function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2800); }
