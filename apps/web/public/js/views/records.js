/* Records and retention (Phase 4), for a firm's administrators and compliance users: when each
   household's relationship ended and when its retention ends, purge requests and their decisions
   (two people: whoever asked cannot approve), the purge register, a household's access log and the
   subject access export. The server enforces every rule; this page only offers what it allows.
   Every call is a session write or read through Store.api (CSRF token included). */
import { Store } from '../api/store.js';
import { save } from '../io/download.js';
import { $, esc, toast } from '../lib/dom.js';
import { fmtDate, fmtTs } from '../lib/format.js';
import { state } from '../state.js';

const UI = { log: null, logRows: [], confirm: null };
const STATUS = { pending: 'Waiting for a decision', rejected: 'Rejected', purged: 'Purged' };

export async function renderRecords() {
  const head = `<div class="sec-head"><div><h2>Records and retention</h2><p>A household is kept for the retention period after its relationship ends (the Money Laundering Regulations 2017 set five years), then purged once a second person approves. Every read of a client file is logged.</p></div></div>`;
  $('#main').innerHTML = head + `<div class="panel"><p class="muted">Loading…</p></div>`;
  let d;
  try { d = await Store.api('GET', 'records'); } catch (e) { $('#main').innerHTML = head + `<div class="banner bad"><div>${esc(e.status === 403 ? 'Only a firm administrator or compliance user can see this page.' : 'Could not load the records. ' + e.message)}</div></div>`; return; }
  if (state.VIEW !== 'records') return;
  const me = Store.email || Store.user;
  const pending = d.requests.filter(q => q.status === 'pending'), decided = d.requests.filter(q => q.status !== 'pending');
  const waiting = new Set(pending.map(q => q.householdId));
  // A waiting request's household still exists: an empty name is "Unnamed", never "(purged)"
  const reqRow = q => `<tr><td><b>${esc(q.status === 'purged' ? '(purged)' : q.householdName || 'Unnamed')}</b><br><span class="muted mono">${esc(q.householdId)}</span></td><td>${esc(fmtDate(q.retentionUntil))}</td><td>${esc(q.reason)}</td><td>${esc(q.requestedBy)}<br><span class="muted">${esc(fmtTs(q.requestedAt))}</span></td>
    <td><div class="addrow">${q.requestedBy === me ? '<span class="muted">Your request: someone else must approve.</span>' : UI.confirm === q.id ? `<button class="btn primary" type="button" data-rec="approve" data-id="${esc(q.id)}">Confirm: purge for good</button>` : `<button class="btn" type="button" data-rec="ask" data-id="${esc(q.id)}">Approve purge</button>`}
      <button class="btn ghost" type="button" data-rec="reject" data-id="${esc(q.id)}">${q.requestedBy === me ? 'Withdraw' : 'Reject'}</button></div></td></tr>`;
  const hhRow = h => `<tr><td><b>${esc(h.name || 'Unnamed')}</b><br><span class="muted">${esc(h.reference || '')}</span></td><td>${esc(h.stage)}</td>
    <td>${h.endedOn ? `${esc(fmtDate(h.endedOn))} <button class="btn ghost" type="button" data-rec="reopen" data-id="${esc(h.id)}"${waiting.has(h.id) ? ' disabled title="A purge request is waiting"' : ''}>Reopen</button>`
      : `<span class="addrow"><input type="date" id="end-${esc(h.id)}" max="${esc(d.today)}" aria-label="Day the relationship ended"><button class="btn ghost" type="button" data-rec="end" data-id="${esc(h.id)}">End relationship</button></span>`}</td>
    <td>${h.retentionUntil ? esc(fmtDate(h.retentionUntil)) + (h.eligible ? ' <span class="pill good">ended</span>' : '') : '–'}</td>
    <td><div class="addrow">${h.eligible && !waiting.has(h.id) ? `<input id="why-${esc(h.id)}" maxlength="500" placeholder="Reason for the purge" aria-label="Reason for the purge"><button class="btn" type="button" data-rec="request" data-id="${esc(h.id)}">Request purge</button>` : ''}
      <button class="btn ghost" type="button" data-rec="sar" data-id="${esc(h.id)}">Subject access export</button><button class="btn ghost" type="button" data-rec="log" data-id="${esc(h.id)}">${UI.log === h.id ? 'Hide access log' : 'Access log'}</button></div></td></tr>
    ${UI.log === h.id ? `<tr><td colspan="5">${UI.logRows.length ? `<table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Outcome</th></tr></thead><tbody>${UI.logRows.slice(0, 200).map(e => `<tr><td style="white-space:nowrap">${esc(fmtTs(e.at))}</td><td>${esc(e.actor)}</td><td>${esc(e.action.replace(/_/g, ' '))}${e.detail ? ' (' + esc(e.detail) + ')' : ''}</td><td>${esc(e.outcome.replace(/_/g, ' '))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No reads recorded.</p>'}</td></tr>` : ''}`;
  $('#main').innerHTML = head +
    `<div class="panel"><h3>Purge requests waiting</h3>${pending.length ? `<div class="tbl-wrap"><table><thead><tr><th>Household</th><th>Retention ended</th><th>Reason</th><th>Asked by</th><th></th></tr></thead><tbody>${pending.map(reqRow).join('')}</tbody></table></div>` : '<p class="muted">None.</p>'}</div>
    <div class="panel"><h3>Households</h3><p class="muted">Retention period: ${d.retentionYears} years after the relationship ends.</p>${d.households.length ? `<div class="tbl-wrap"><table><thead><tr><th>Household</th><th>Status</th><th>Relationship ended</th><th>Retention until</th><th></th></tr></thead><tbody>${d.households.map(hhRow).join('')}</tbody></table></div>` : '<p class="muted">No households.</p>'}</div>
    <div class="panel"><h3>Purge register</h3>${decided.length ? `<div class="tbl-wrap"><table><thead><tr><th>Household</th><th>Decision</th><th>Asked by</th><th>Decided by</th><th>Removed</th></tr></thead><tbody>${decided.map(q => `<tr><td><span class="mono">${esc(q.householdId)}</span>${q.householdName ? '<br>' + esc(q.householdName) : ''}</td><td>${esc(STATUS[q.status] || q.status)}${q.note ? '<br><span class="muted">' + esc(q.note) + '</span>' : ''}</td><td>${esc(q.requestedBy)}<br><span class="muted">${esc(q.reason)}</span></td><td>${esc(q.decidedBy || '')}<br><span class="muted">${esc(q.decidedAt ? fmtTs(q.decidedAt) : '')}</span></td><td>${q.counts ? esc(`${q.counts.versions} version(s), ${q.counts.auditEntries} audit entr${q.counts.auditEntries === 1 ? 'y' : 'ies'}`) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing purged or rejected yet.</p>'}</div>`;
  $('#main').onclick = onClick;
}

async function onClick(e) {
  const b = e.target.closest('[data-rec]');
  if (!b) return;
  const id = b.dataset.id, act = b.dataset.rec;
  const fail = x => toast(x.message || 'Not done');
  try {
    if (act === 'end') {
      const v = $('#end-' + id).value;
      if (!v) { toast('Choose the day the relationship ended'); return; }
      await Store.api('PUT', `households/${encodeURIComponent(id)}/relationship`, { endedOn: v }); toast('Relationship ended: retention clock started');
    } else if (act === 'reopen') {
      await Store.api('PUT', `households/${encodeURIComponent(id)}/relationship`, { endedOn: null }); toast('Relationship reopened');
    } else if (act === 'request') {
      const reason = $('#why-' + id).value.trim();
      if (!reason) { toast('Give the reason for the purge'); return; }
      await Store.api('POST', `households/${encodeURIComponent(id)}/purge-requests`, { reason }); toast('Purge requested: a second person must approve');
    } else if (act === 'ask') { UI.confirm = id; }
    else if (act === 'approve') {
      UI.confirm = null;
      await Store.api('POST', `purge-requests/${encodeURIComponent(id)}/approve`, {}); toast('Household purged');
    } else if (act === 'reject') {
      await Store.api('POST', `purge-requests/${encodeURIComponent(id)}/reject`, {}); toast('Purge request closed');
    } else if (act === 'sar') {
      const p = await Store.api('GET', `households/${encodeURIComponent(id)}/subject-access`);
      await save(`subject-access-${String(p.household.reference || id).replace(/[^\w-]+/g, '_')}-${p.generatedAt.slice(0, 10)}.json`, JSON.stringify(p, null, 2));
      return;
    } else if (act === 'log') {
      if (UI.log === id) { UI.log = null; UI.logRows = []; }
      else { UI.logRows = await Store.api('GET', `households/${encodeURIComponent(id)}/access`); UI.log = id; }
    }
  } catch (x) { fail(x); }
  renderRecords();
}
