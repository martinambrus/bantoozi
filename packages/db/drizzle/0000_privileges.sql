-- Spec 02 §1.2 privilege defaults. First migration, run as bantoozi_owner, so the defaults cover
-- every object created by later migrations automatically.
GRANT USAGE ON SCHEMA public TO bantoozi_app, bantoozi_worker;
-- No default table privileges for bantoozi_app: every new API-visible table is reviewed explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE bantoozi_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bantoozi_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE bantoozi_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bantoozi_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE bantoozi_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
