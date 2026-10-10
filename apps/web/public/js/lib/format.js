/* How numbers and dates are shown (UK formats). A value that is not a number shows as '–'. */

// Pounds: £12,345 (dp decimal places); negative as −£
export const gbp = (n, dp = 0) => { if (!isFinite(n)) return '–'; const s = Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: dp, minimumFractionDigits: dp }); return (n < 0 ? '−£' : '£') + s; };

// Pounds, short: £1.25m, £45k, £9,876
export const gbpK = n => { if (!isFinite(n)) return '–'; const a = Math.abs(n); const s = a >= 1e6 ? (a / 1e6).toFixed(2) + 'm' : a >= 1e4 ? Math.round(a / 1e3) + 'k' : Math.round(a).toLocaleString('en-GB'); return (n < 0 ? '−£' : '£') + s; };

// A fraction as a percentage: 0.125 -> 13% (dp decimal places)
export const pct = (n, dp = 0) => isFinite(n) ? (n * 100).toFixed(dp) + '%' : '–';

// A date as 9 Oct 2026 (dates are read with the rules' own parser in core.js)
export const fmtDate = s => { const d = window.HWP.parseDate(s); return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '–'; };

// A save time as 9 Oct 2026, 14:05 (in the viewer's time zone); anything unreadable is shown as it is
export const fmtTs = s => { const d = new Date(s); return isNaN(d) ? s : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
