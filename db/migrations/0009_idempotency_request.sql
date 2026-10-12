-- The request each create key was used for, as a keyed hash (HMAC-SHA256 with the firm's index
-- key), so the same key sent with a different request is refused instead of answered with a reply
-- that is not its own. Nullable: keys stored before this migration carry no hash and still replay.
alter table idempotency_keys add column if not exists request_hash text;
