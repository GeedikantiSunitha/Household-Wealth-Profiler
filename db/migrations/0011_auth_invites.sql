-- Phase 2 (2.6): invitations and access requests. The app role may now create an account and its
-- membership, and decide an access request, but only inside a sign-in transaction (the auth_rows
-- policies of 0010 require app.auth to be set; a bare query still inserts nothing). It still cannot
-- change an account's email, name or active flag, nor a membership's role or active flag (Phase 3,
-- RBAC), and cannot delete any of these rows. An invitation to an existing account therefore adds
-- a membership where none exists and changes nothing else.
grant insert on users, memberships to hwp_app;
grant update (status, decided_by, decided_at, firm_id) on access_requests to hwp_app;
