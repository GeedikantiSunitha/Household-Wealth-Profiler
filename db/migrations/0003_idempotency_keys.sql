-- Idempotency keys for creating households. A repeated create (a double-click, a retried
-- request) with the same key from the same user returns the first reply instead of making a
-- second household. A key lives 24 hours; the server removes older ones as it goes. The table
-- holds no client data: the scope is a hash of the user and key, the reply is the id and version.

create table if not exists idempotency_keys (
  scope      text primary key,
  reply      text not null,
  created_at timestamptz not null default now()
);
create index if not exists idempotency_keys_created on idempotency_keys (created_at);
