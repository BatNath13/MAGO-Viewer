-- ===================================================================
-- MAGO · Base séparée des accès client
-- -------------------------------------------------------------------
-- À exécuter dans la base PostgreSQL : mago_access
--
-- Cette base est volontairement séparée de mago_enrichment, qui garde les
-- attributs du maillage (attribute, object, model, etc.).
--
-- Table visible dans pgAdmin :
--   Database: mago_access
--   Schemas > public > Tables > client_access
--
-- Colonnes utiles :
--   lien_client      : URL à envoyer au client
--   identifiant      : login du client
--   mot_de_passe     : mot de passe visible/modifiable dans pgAdmin
--   date_expiration  : coupure automatique à la date + heure + minute
--   active           : false = accès coupé immédiatement
-- ===================================================================

CREATE TABLE IF NOT EXISTS client_access (
  id               SERIAL PRIMARY KEY,
  lien_client      TEXT NOT NULL,
  identifiant      TEXT NOT NULL,
  mot_de_passe     TEXT NOT NULL,
  date_expiration  TIMESTAMPTZ,
  model_id         INTEGER NOT NULL,
  active           BOOLEAN NOT NULL DEFAULT TRUE,

  -- Champs techniques pour les sessions JWT.
  username         TEXT,
  password_hash    TEXT,
  expires_at       TIMESTAMPTZ,
  token_version    INTEGER NOT NULL DEFAULT 1,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE client_access ADD COLUMN IF NOT EXISTS lien_client TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS identifiant TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS mot_de_passe TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS date_expiration TIMESTAMPTZ;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS model_id INTEGER;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE client_access
   SET username = COALESCE(username, identifiant),
       expires_at = COALESCE(expires_at, date_expiration)
 WHERE username IS NULL OR expires_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_access_identifiant_unique
  ON client_access (identifiant);
CREATE INDEX IF NOT EXISTS idx_client_access_model_id ON client_access (model_id);
CREATE INDEX IF NOT EXISTS idx_client_access_expiration ON client_access (date_expiration);

CREATE OR REPLACE FUNCTION trg_client_access_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  NEW.username := COALESCE(NEW.identifiant, NEW.username);
  NEW.expires_at := COALESCE(NEW.date_expiration, NEW.expires_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS client_access_updated_at ON client_access;
CREATE TRIGGER client_access_updated_at
BEFORE UPDATE ON client_access
FOR EACH ROW
EXECUTE FUNCTION trg_client_access_updated_at();

CREATE OR REPLACE VIEW client_access_admin AS
SELECT
  id,
  lien_client AS lien,
  identifiant,
  mot_de_passe,
  model_id,
  active,
  date_expiration,
  CASE
    WHEN active = false THEN 'désactivé'
    WHEN date_expiration IS NOT NULL AND date_expiration <= now() THEN 'expiré'
    ELSE 'actif'
  END AS etat,
  created_at,
  updated_at
FROM client_access
ORDER BY id DESC;
