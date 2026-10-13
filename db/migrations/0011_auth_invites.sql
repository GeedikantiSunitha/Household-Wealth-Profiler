-- Phase 2 (2.6): invitations and access requests. The app role may now create an account and its
-- membership, and decide an access request, but only inside a sign-in transaction (the auth_rows
-- policies of 0010 require app.auth to be set; a bare query still inserts nothing). It still cannot
-- change an account's email or deactivate anyone (Phase 3), and cannot delete any of these rows.
grant insert on users, memberships to hwp_app;
grant update (role, active) on memberships to hwp_app;
grant update (status, decided_by, decided_at, firm_id) on access_requests to hwp_app;
