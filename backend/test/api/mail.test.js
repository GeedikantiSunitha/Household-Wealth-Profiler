// backend/src/auth/mail.js: sending the sign-in emails (reset and invitation links, warnings)
// over SMTP with Node alone, and the log fallback outside production. Checked against a fake SMTP
// server here: plain, and with STARTTLS using a throwaway certificate made by openssl (skipped
// when openssl is not installed).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMailer, parseSmtpUrl, dot } = require('../../../backend/src/services/auth/mail.js');

// A fake SMTP server: records what it was told; offers STARTTLS when given a certificate
function fakeSmtp({ cert = null, auth = true } = {}) {
  const log = { commands: [], messages: [], auth: null };
  const server = net.createServer(socket => {
    let s = socket, buf = '', inData = false, msg = '';
    const write = line => s.write(line + '\r\n');
    const attach = sock => { s = sock; s.on('data', onData); };
    const onData = d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; log.messages.push(msg); msg = ''; write('250 queued'); } else msg += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'; continue; }
        log.commands.push(line.startsWith('AUTH PLAIN') ? 'AUTH PLAIN *' : line);
        const [cmd] = line.split(' ');
        if (cmd === 'EHLO') { write('250-fake.example'); if (cert && s === socket) write('250-STARTTLS'); write('250-AUTH PLAIN LOGIN'); write('250 8BITMIME'); }
        else if (cmd === 'STARTTLS') { write('220 go ahead'); socket.removeListener('data', onData); const t = new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert }); attach(t); }
        else if (cmd === 'AUTH') { log.auth = Buffer.from(line.split(' ')[2], 'base64').toString('utf8').split('\0'); write(auth ? '235 ok' : '535 no'); }
        else if (cmd === 'MAIL' || cmd === 'RCPT') write('250 ok');
        else if (cmd === 'DATA') { inData = true; write('354 go'); }
        else if (cmd === 'QUIT') { write('221 bye'); s.end(); }
        else write('500 what');
      }
    };
    write('220 fake.example ready');
    s.on('data', onData);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, log, close: () => server.close() })));
}

function throwawayCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-cert-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

test('SMTP_URL: user, password, host, port and whether TLS is implicit (smtps) or started (smtp)', () => {
  assert.deepEqual(parseSmtpUrl('smtp://mailer%40example.com:s3cr%3At@mail.example.com:587'), { host: 'mail.example.com', port: 587, user: 'mailer@example.com', pass: 's3cr:t', implicitTls: false });
  assert.deepEqual(parseSmtpUrl('smtps://u:p@mail.example.com'), { host: 'mail.example.com', port: 465, user: 'u', pass: 'p', implicitTls: true });
  assert.deepEqual(parseSmtpUrl('smtp://mail.example.com'), { host: 'mail.example.com', port: 587, user: '', pass: '', implicitTls: false });
  assert.throws(() => parseSmtpUrl('http://mail.example.com'), /SMTP_URL must start with smtp:\/\/ or smtps:\/\//);
});

test('a line starting with a dot is doubled on the wire (RFC 5321), and the message ends with CRLF.CRLF', () => {
  assert.equal(dot('hi\n.hidden\n..two\nend'), 'hi\r\n..hidden\r\n...two\r\nend');
});

test('without SMTP_URL outside production the message is written to the log and nothing is sent; in production it is refused', async () => {
  const logged = [];
  const dev = createMailer({ smtpUrl: '', from: 'Profiler <no-reply@example.com>', production: false, log: m => logged.push(m) });
  const r = await dev.send({ to: 'sam@example.com', subject: 'Reset your password', text: 'Link: https://x/#reset=abc' });
  assert.deepEqual(r, { delivered: false, logged: true });
  assert.equal(logged.length, 1); assert.match(logged[0], /EMAIL NOT SENT \(no SMTP_URL\)/); assert.match(logged[0], /To: sam@example.com/); assert.match(logged[0], /reset=abc/);
  const prod = createMailer({ smtpUrl: '', from: 'x@example.com', production: true, log: m => logged.push(m) });
  await assert.rejects(prod.send({ to: 'sam@example.com', subject: 's', text: 't' }), { status: 503, code: 'email_unavailable' });
});

test('plain SMTP (development only): EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA with headers and a dotted body, QUIT', async () => {
  const smtp = await fakeSmtp();
  try {
    const m = createMailer({ smtpUrl: `smtp://mailer:pw@127.0.0.1:${smtp.port}?tls=off`, from: 'Profiler <no-reply@example.com>', production: false, log: () => {} });
    const r = await m.send({ to: 'Sam <sam@example.com>', subject: 'Reset your password: £ and café', text: 'Line one\n.starts with a dot\n\nhttps://x/#reset=abc' });
    assert.deepEqual(r, { delivered: true, logged: false });
    assert.deepEqual(smtp.log.commands, ['EHLO localhost', 'AUTH PLAIN *', 'MAIL FROM:<no-reply@example.com>', 'RCPT TO:<sam@example.com>', 'DATA', 'QUIT']);
    assert.deepEqual(smtp.log.auth, ['', 'mailer', 'pw']);
    const msg = smtp.log.messages[0];
    assert.match(msg, /^From: Profiler <no-reply@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\nDate: .+\r\nMessage-ID: <[^>]+>\r\nMIME-Version: 1.0\r\nContent-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\nAuto-Submitted: auto-generated\r\n\r\n/);
    assert.ok(msg.endsWith('Line one\r\n.starts with a dot\r\n\r\nhttps://x/#reset=abc\r\n'), 'the dot was undoubled by the server, so it was doubled on the wire');
    assert.equal(Buffer.from(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(msg)[1], 'base64').toString('utf8'), 'Reset your password: £ and café');
  } finally { smtp.close(); }
});

test('smtp:// starts TLS when the server offers it, then authenticates over the encrypted connection; in production TLS is required', async () => {
  const cert = throwawayCert();
  if (!cert) { console.log('openssl not available: STARTTLS not exercised'); return; }
  const smtp = await fakeSmtp({ cert });
  try {
    const m = createMailer({ smtpUrl: `smtp://mailer:pw@127.0.0.1:${smtp.port}`, from: 'no-reply@example.com', production: true, log: () => {}, tlsOptions: { ca: cert.cert, servername: '127.0.0.1', checkServerIdentity: () => undefined } });
    const r = await m.send({ to: 'sam@example.com', subject: 'Invitation', text: 'https://x/#invite=def' });
    assert.deepEqual(r, { delivered: true, logged: false });
    assert.deepEqual(smtp.log.commands, ['EHLO localhost', 'STARTTLS', 'EHLO localhost', 'AUTH PLAIN *', 'MAIL FROM:<no-reply@example.com>', 'RCPT TO:<sam@example.com>', 'DATA', 'QUIT']);
    assert.match(smtp.log.messages[0], /invite=def/);
  } finally { smtp.close(); }
  const plain = await fakeSmtp();
  try {
    const m = createMailer({ smtpUrl: `smtp://mailer:pw@127.0.0.1:${plain.port}`, from: 'no-reply@example.com', production: true, log: () => {} });
    await assert.rejects(m.send({ to: 'sam@example.com', subject: 's', text: 't' }), /does not offer STARTTLS/);
    assert.ok(!plain.log.commands.includes('AUTH PLAIN *'), 'no credentials were sent in clear');
  } finally { plain.close(); }
});

test('a refused login or a server error surfaces as a clear error, and the recipient address must be plain', async () => {
  const smtp = await fakeSmtp({ auth: false });
  try {
    const m = createMailer({ smtpUrl: `smtp://mailer:pw@127.0.0.1:${smtp.port}?tls=off`, from: 'no-reply@example.com', production: false, log: () => {} });
    await assert.rejects(m.send({ to: 'sam@example.com', subject: 's', text: 't' }), /SMTP AUTH refused: 535 no/);
    await assert.rejects(m.send({ to: 'sam@example.com\r\nBcc: evil@example.com', subject: 's', text: 't' }), /not a valid address/);
  } finally { smtp.close(); }
});
