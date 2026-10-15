/* Sending the sign-in emails (reset and invitation links, warnings) over SMTP, with Node alone.
   SMTP_URL names the server: smtps://user:pass@host:465 (TLS from the start) or
   smtp://user:pass@host:587 (STARTTLS: the connection is upgraded before anything else is sent;
   a server that does not offer it is refused, except with ?tls=off outside production, for a
   local test server). Credentials go as AUTH PLAIN over the encrypted connection only. Messages
   are plain text, UTF-8, with the subject encoded; a line starting with a dot is doubled on the
   wire as RFC 5321 requires. Addresses must be plain: no line breaks, so a message cannot grow
   extra recipients or headers.
   Without SMTP_URL: outside production the whole message is written to the log instead (a
   developer reads the link there); in production sending is refused (503 email_unavailable). */
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const TIMEOUT_MS = 15000;
const ADDRESS = /^(?:([^<>\r\n]{1,100}) )?<?([^\s<>@]+@[^\s<>@]+)>?$/; // a host without a dot (localhost) is fine for the development sender

function parseSmtpUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('SMTP_URL must start with smtp:// or smtps://'); }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://');
  const implicitTls = u.protocol === 'smtps:';
  return { host: u.hostname, port: +u.port || (implicitTls ? 465 : 587), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password), implicitTls, ...(u.searchParams.get('tls') === 'off' ? { tlsOff: true } : {}) };
}

// CRLF line ends and a doubled leading dot, for the DATA phase
const dot = text => String(text).replace(/\r?\n/g, '\r\n').split('\r\n').map(l => l.startsWith('.') ? '.' + l : l).join('\r\n');

function parseAddress(a) {
  const m = ADDRESS.exec(String(a || '').trim());
  if (!m) throw Object.assign(new Error(`"${String(a).slice(0, 40)}" is not a valid address`), { status: 400, code: 'bad_request' });
  return { display: m[1] ? `${m[1]} <${m[2]}>` : m[2], addr: m[2] };
}

// One SMTP conversation; resolves when the server has accepted the message
function deliver({ host, port, user, pass, implicitTls, tlsOff }, { from, to, data, production, tlsOptions = {} }) {
  return new Promise((resolve, reject) => {
    let socket, buf = '', done = false, waiting = null;
    const fail = e => { if (done) return; done = true; try { socket.destroy(); } catch (x) { /* closed */ } reject(e); };
    const finish = () => { if (done) return; done = true; try { socket.end(); } catch (x) { /* closed */ } resolve(); };
    const listen = s => {
      socket = s;
      s.setTimeout(TIMEOUT_MS, () => fail(new Error(`SMTP ${host}:${port}: no answer within ${TIMEOUT_MS / 1000} s`)));
      s.on('error', fail);
      s.on('data', d => { buf += d.toString('utf8'); pump(); });
    };
    // A reply is complete when a line reads "NNN " (not "NNN-"); multi-line replies are joined
    const pump = () => {
      if (!waiting) return;
      const lines = buf.split('\r\n'); const out = [];
      for (let i = 0; i < lines.length - 1; i++) { out.push(lines[i]); if (/^\d{3} /.test(lines[i])) { buf = lines.slice(i + 1).join('\r\n'); const w = waiting; waiting = null; w(out); return; } }
    };
    const read = () => new Promise(ok => { waiting = ok; pump(); });
    const cmd = async (line, expect) => {
      if (line !== null) socket.write(line + '\r\n');
      const reply = await read();
      const code = reply[reply.length - 1].slice(0, 3);
      if (!expect.includes(code)) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'} refused: ${reply[reply.length - 1]}`);
      return reply;
    };
    (async () => {
      const greeting = await cmd(null, ['220']);
      void greeting;
      let ehlo = await cmd('EHLO localhost', ['250']);
      const offers = ehlo.some(l => /^250[- ]STARTTLS/i.test(l));
      if (!implicitTls) {
        if (offers) {
          await cmd('STARTTLS', ['220']);
          socket.removeAllListeners('data'); socket.removeAllListeners('error'); socket.setTimeout(0);
          const secure = tls.connect({ socket, servername: host, ...tlsOptions });
          await new Promise((ok, no) => { secure.once('secureConnect', ok); secure.once('error', no); });
          buf = ''; listen(secure);
          ehlo = await cmd('EHLO localhost', ['250']);
        } else if (production || !tlsOff) {
          throw new Error(`SMTP ${host}:${port} does not offer STARTTLS; credentials and messages would travel in clear. Use smtps:// or a server with STARTTLS.`);
        }
      }
      if (user) {
        const r = await (async () => { socket.write('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64') + '\r\n'); return read(); })();
        if (!r[r.length - 1].startsWith('235')) throw new Error(`SMTP AUTH refused: ${r[r.length - 1]}`);
      }
      await cmd(`MAIL FROM:<${from}>`, ['250']);
      await cmd(`RCPT TO:<${to}>`, ['250', '251']);
      await cmd('DATA', ['354']);
      await cmd(data + '\r\n.', ['250']);
      try { await cmd('QUIT', ['221']); } catch (e) { /* the message was accepted already */ }
      finish();
    })().catch(fail);
    if (implicitTls) listen(tls.connect({ host, port, servername: host, ...tlsOptions }));
    else listen(net.connect({ host, port }));
  });
}

function createMailer({ smtpUrl = '', from, production = false, log = m => console.error(new Date().toISOString(), m), tlsOptions = {} }) {
  const server = smtpUrl ? parseSmtpUrl(smtpUrl) : null;
  const sender = parseAddress(from);
  async function send({ to, subject, text }) {
    const rcpt = parseAddress(to);
    if (/[\r\n]/.test(String(subject))) throw Object.assign(new Error('Subject must be one line'), { status: 400, code: 'bad_request' });
    if (!server) {
      if (production) throw Object.assign(new Error('Email is not set up on this server (SMTP_URL). Ask your administrator.'), { status: 503, code: 'email_unavailable' });
      log(`EMAIL NOT SENT (no SMTP_URL): development only\nTo: ${rcpt.display}\nSubject: ${subject}\n\n${text}\n`);
      return { delivered: false, logged: true };
    }
    const headers = [
      `From: ${sender.display}`, `To: ${rcpt.display}`,
      `Subject: =?UTF-8?B?${Buffer.from(String(subject), 'utf8').toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${server.host}>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', 'Auto-Submitted: auto-generated',
    ];
    await deliver(server, { from: sender.addr, to: rcpt.addr, data: headers.join('\r\n') + '\r\n\r\n' + dot(text), production, tlsOptions });
    return { delivered: true, logged: false };
  }
  return { send, configured: !!server };
}

module.exports = { createMailer, parseSmtpUrl, dot, parseAddress };
