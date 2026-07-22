-- ============================================================================
-- Deprecated compatibility file
--
-- Client credentials are stored in the separate database mago_access and are
-- initialized by 002_client_access_database.sql. This file intentionally makes
-- no schema change. Use INSTALLER_VIEWER_COMPLET.ps1 for a clean installation.
-- ============================================================================
DO $$
BEGIN
  RAISE NOTICE '001_client_access.sql is obsolete: use mago_access / 002_client_access_database.sql.';
END
$$;
