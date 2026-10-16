/* The emails the sign-in sends, as plain text: a reset link, an invitation link, a warning after
   repeated failures, a notice when a recovery code was used, and an access request for the
   operator. Links put the token in the fragment (#reset=..., #invite=...): a browser never sends
   the fragment to the server, so the token cannot land in a log or a Referer header. Sending
   failures are reported to the caller for links (the user must know) and only logged for
   warnings, which must never block a sign-in. */
'use strict';

function createNotify({ mailer, publicUrl, operatorEmail = '', appName = 'Household Wealth Profiler', log = m => console.error(new Date().toISOString(), m) }) {
  const link = (kind, token) => `${publicUrl}/#${kind}=${token}`;
  const quietly = async (what, fn) => { try { await fn(); } catch (e) { log(`${what}: email not sent: ${e.message}`); } };
  const signOff = `\n\nIf this was not you, or you have any concern, contact your administrator.\n\n${appName}`;

  return {
    // The verification link after a registration: 24 hours, single use
    verifyLink: ({ email, name }, token) => mailer.send({ to: email, subject: `Confirm your email address for ${appName}`,
      text: `Hello ${name || ''},\n\nThank you for registering with ${appName}.\n\nTo confirm your email address, open this link within 24 hours:\n\n${link('verify', token)}\n\nThen sign in with your email address and the password you chose.\n\nIf you did not register, ignore this email: nothing is open until the address is confirmed.\n\n${appName}` }),
    // A registration with an address that already has an account: the holder is told, nobody else is
    alreadyRegistered: user => quietly('already registered notice', () => mailer.send({ to: user.email, subject: `${appName}: this address already has an account`,
      text: `Hello ${user.name || ''},\n\nSomeone (hopefully you) tried to register with this email address, which already has a ${appName} account.\n\nTo sign in, use your password; if you have forgotten it, choose "Forgotten your password?" on the sign-in page.${signOff}` })),
    // The reset link: 30 minutes, single use
    resetLink: (user, token) => mailer.send({ to: user.email, subject: `Reset your ${appName} password`,
      text: `Hello ${user.name || ''},\n\nSomeone (hopefully you) asked to reset the password for your ${appName} account.\n\nTo choose a new password, open this link within 30 minutes:\n\n${link('reset', token)}\n\nThe link works once. If you did not ask for this, you can ignore this email: your password has not changed.${signOff}` }),
    // The invitation: 24 hours, single use
    inviteLink: ({ email, name }, token, { firmName = '' } = {}) => mailer.send({ to: email, subject: `Your ${appName} account`,
      text: `Hello ${name || ''},\n\nAn account has been created for you in ${appName}${firmName ? ` for ${firmName}` : ''}.\n\nTo choose your password, open this link within 24 hours:\n\n${link('invite', token)}\n\nThen sign in with your email address and set up your authenticator app, which is required for every sign-in.${signOff}` }),
    // Someone who already has an account was invited to a firm: no link (a link would reset their password). The
    // invitation waits until they accept it when they next sign in; nothing is open to them before that.
    invitedToFirm: ({ email, name }, { firmName = '', roles = [] } = {}) => mailer.send({ to: email, subject: `You have been invited to ${firmName || 'another firm'} in ${appName}`,
      text: `Hello ${name || ''},\n\nYou have been invited to join ${firmName || 'another firm'} in ${appName}${roles.length ? ` as ${roles.join(' and ')}` : ''}.\n\nNothing changes until you accept. Sign in as usual with your email address, password and authenticator app; you will be asked whether to accept or decline the invitation:\n\n${publicUrl}${signOff}` }),
    lockoutWarning: (user, { failures, ip } = {}) => quietly('lockout warning', () => mailer.send({ to: user.email, subject: `${appName}: repeated failed sign-ins`,
      text: `Hello ${user.name || ''},\n\nThere have been ${failures} failed attempts to sign in to your ${appName} account${ip ? ` from the address ${ip}` : ''}. Each further attempt is delayed.\n\nIf this was you, wait a minute and try again, or use "Forgotten your password?" on the sign-in page.${signOff}` })),
    recoveryUsed: (user, { ip } = {}) => quietly('recovery notice', () => mailer.send({ to: user.email, subject: `${appName}: a recovery code was used`,
      text: `Hello ${user.name || ''},\n\nA recovery code was just used to sign in to your ${appName} account${ip ? ` from the address ${ip}` : ''}. The authenticator app on that account no longer counts: a new one must be set up at the next sign-in, and every other session has been ended.${signOff}` })),
    mfaReset: user => quietly('authenticator reset notice', () => mailer.send({ to: user.email, subject: `${appName}: your authenticator app was reset`,
      text: `Hello ${user.name || ''},\n\nAn operator has reset the authenticator app on your ${appName} account, and every recovery code and every session has been ended. At your next sign-in you will set up a new authenticator app and receive new recovery codes.${signOff}` })),
  };
}

module.exports = { createNotify };
