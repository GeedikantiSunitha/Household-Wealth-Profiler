# 0002: Known limits of the current sign-in, kept until it is replaced

- **Date:** 2026-10-10
- **Status:** The three limits below were fixed in step 0.5.2 (unknown names now cost a full password check, the maps are pruned and capped, a malformed hash is refused at start-up). Basic sign-in itself is development-only: `NODE_ENV=production` refuses it, and Phase 2 replaces it with the app's own sign-in.
- **Code:** `backend/src/auth/providers/basic/index.js` (moved unchanged from `server.js` in step B9)

## Context

Step B9 moved HTTP Basic sign-in into its own module without changing behaviour (checked against
the previous code on 3,000 random sign-in attempts). Reading it closely showed three weaknesses.
Fixing any of them changes behaviour, which the restructure rules do not allow, so they are recorded
here instead.

## The limits

| Limit | Effect | Fix when sign-in is replaced |
| --- | --- | --- |
| An unknown name is answered without running the password check | Responses for unknown names are measurably faster, which hints at which names exist | Run the password check against a dummy hash for unknown names |
| The failure list and the login cache are never pruned | Both grow for as long as the server runs (one entry per address that failed, one per distinct login header) | Expire old entries, or cap the size |
| A malformed password hash in `AUTH_USERS` (wrong length) makes that user's sign-in fail with a server error instead of a refusal | A configuration mistake shows as "Server error" | Check hash length when settings are loaded and refuse to start |

Also inherent to HTTP Basic: no sign-out, no two-step verification, no roles, and adding or removing a
user needs a restart. These are the reasons sign-in is due to be replaced (see the consolidation plan).

## Decision

Keep the behaviour as it is through Stage B. The new module documents these limits in its header, and
its tests (`test/api/auth.test.js`) describe today's behaviour, so the fix in Stage C will show up as
a deliberate test change.
