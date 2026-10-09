#!/usr/bin/env node
// Operator tool for the Supabase edition: create and manage customer firms.
// Needs SUPABASE_URL, SUPABASE_SECRET_KEY (or the legacy service_role key) and APP_ORIGIN.
//   node scripts/firms.js list
//   node scripts/firms.js create "Firm name" admin@firm.co.uk "Admin Name" [seats]
//   node scripts/firms.js seats <firm-id> <seats>
//   node scripts/firms.js suspend <firm-id>      (everyone at the firm loses access; data is kept)
//   node scripts/firms.js activate <firm-id>
'use strict';
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/+$/, '');
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY'); process.exit(1); }
const headers = { apikey: KEY, 'Content-Type': 'application/json', ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}) };
async function call(method, p, body, extra = {}) {
  const r = await fetch(URL_ + p, { method, headers: { ...headers, ...extra }, body: body && JSON.stringify(body) });
  const text = await r.text(); const j = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${(j && (j.msg || j.message || j.error_description || j.error)) || text}`);
  return j;
}
const rest = (m, p, b) => call(m, '/rest/v1/' + p, b, { Prefer: 'return=representation' });

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'list') {
    const firms = await rest('GET', 'firms?select=id,name,status,seats,created_at,members(active)&order=created_at');
    console.table(firms.map(f => ({ id: f.id, name: f.name, status: f.status, seats: f.seats, active: f.members.filter(m => m.active).length })));
  } else if (cmd === 'create') {
    const [name, email, admin, seats = '5'] = a;
    if (!name || !email || !admin) throw new Error('usage: create "Firm name" admin@email "Admin Name" [seats]');
    if (!ORIGIN) throw new Error('Set APP_ORIGIN to the front-end address, e.g. https://profiler.example.com');
    const [firm] = await rest('POST', 'firms', { name, seats: +seats });
    const user = await call('POST', '/auth/v1/invite?redirect_to=' + encodeURIComponent(ORIGIN + '/?setpw=1'), { email: email.toLowerCase(), data: { name: admin } });
    await rest('POST', 'members', { user_id: user.id, firm_id: firm.id, email: email.toLowerCase(), display_name: admin, role: 'admin' });
    console.log(`Created ${name} (${firm.id}) with ${seats} seats. Invitation emailed to ${email}.`);
  } else if (cmd === 'seats' || cmd === 'suspend' || cmd === 'activate') {
    const [id, n] = a;
    const patch = cmd === 'seats' ? { seats: +n } : { status: cmd === 'suspend' ? 'suspended' : 'active' };
    const r = await rest('PATCH', 'firms?id=eq.' + encodeURIComponent(id), patch);
    if (!r.length) throw new Error('No firm with that id');
    console.log(r[0]);
  } else {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 9).join('\n'));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
