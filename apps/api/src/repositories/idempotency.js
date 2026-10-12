// Idempotency keys, shared by both stores. A create may carry a key; a repeat with the same key
// (same firm, same user) within a day replays the first reply instead of making a second household.
// The request is stored beside the reply as a keyed hash (HMAC with the firm's index key, so the
// stored value says nothing without the firm's key), and the same key with a different request is
// refused: a reply belongs to the request that earned it.
'use strict';
const crypto = require('node:crypto');

const requestHash = (indexKey, request) => request == null ? null : crypto.createHmac('sha256', indexKey).update(String(request), 'utf8').digest('hex');
const mismatch = () => Object.assign(new Error('This Idempotency-Key was already used for a different request'), { status: 422 });
// The reply to give for a stored key, or a refusal. A stored key without a hash (kept before hashes
// were recorded) or a caller that sent no request replays as before.
function replay(stored, hash) {
  if (stored.requestHash && hash && stored.requestHash !== hash) throw mismatch();
  return stored.reply;
}

module.exports = { requestHash, replay, mismatch };
