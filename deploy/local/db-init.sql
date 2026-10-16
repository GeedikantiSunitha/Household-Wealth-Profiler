-- The three roles the app expects (README, "Optional: keep the data in PostgreSQL"), for the
-- rehearsal in deploy/local/compose.yml only: fixed passwords, a throwaway database.
create role hwp_owner    login password 'rehearsal-owner'    nosuperuser nobypassrls nocreatedb nocreaterole;
create role hwp_app      login password 'rehearsal-app'      nosuperuser nobypassrls nocreatedb nocreaterole;
create role hwp_operator login password 'rehearsal-operator' nosuperuser nobypassrls nocreatedb nocreaterole;
grant usage  on schema public to hwp_owner, hwp_app, hwp_operator;
grant create on schema public to hwp_owner;
