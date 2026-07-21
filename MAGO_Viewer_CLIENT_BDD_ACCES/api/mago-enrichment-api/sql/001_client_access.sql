-- ===================================================================
-- MAGO · Base de données des accès client
-- -------------------------------------------------------------------
-- Une ligne = un accès client = un lien + identifiant + mot de passe
-- + date d'expiration modifiable directement dans PostgreSQL / pgAdmin.
--
-- Colonnes importantes à gérer dans pgAdmin :
--   lien_client      : URL à envoyer au client
--   identifiant      : login du client
--   mot_de_passe     : mot de passe à communiquer au client
--   date_expiration  : coupure automatique à la date + heure + minute
--   active           : false = accès coupé immédiatement
--
-- NOTE : mot_de_passe est stocké en clair car c'est le fonctionnement demandé
-- pour pouvoir le voir/modifier dans la base. Pour une mise en production
-- publique stricte, il faudra revenir à un stockage hashé uniquement.
-- ===================================================================

CREATE TABLE IF NOT EXISTS client_access (
  id               SERIAL PRIMARY KEY,

  -- Gestion lisible dans pgAdmin
  lien_client      TEXT,
  identifiant      TEXT,
  mot_de_passe     TEXT,
  date_expiration  TIMESTAMPTZ,

  -- Lien technique vers la scène / le modèle
  model_id         INTEGER REFERENCES model(id) ON DELETE CASCADE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,

  -- Compatibilité avec l'ancien patch JWT/hashé
  username         TEXT,
  password_hash    TEXT,
  expires_at       TIMESTAMPTZ,
  token_version    INTEGER NOT NULL DEFAULT 1,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration douce si tu avais déjà installé l'ancien patch.
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS lien_client TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS identifiant TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS mot_de_passe TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS date_expiration TIMESTAMPTZ;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS model_id INTEGER REFERENCES model(id) ON DELETE CASCADE;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE client_access ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Reprise des anciennes colonnes vers les nouvelles, si elles existent déjà.
UPDATE client_access
   SET identifiant = COALESCE(identifiant, username),
       date_expiration = COALESCE(date_expiration, expires_at)
 WHERE identifiant IS NULL OR date_expiration IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_access_identifiant_unique
  ON client_access (lower(identifiant))
  WHERE identifiant IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_access_model_id ON client_access (model_id);
CREATE INDEX IF NOT EXISTS idx_client_access_expiration ON client_access (date_expiration);

CREATE OR REPLACE FUNCTION trg_client_access_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();

  -- Compatibilité : si tu modifies les nouvelles colonnes dans pgAdmin,
  -- les anciennes colonnes restent synchronisées pour le code existant.
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

-- Vue de lecture confortable dans pgAdmin.
CREATE OR REPLACE VIEW client_access_admin AS
SELECT
  id,
  lien_client       AS lien,
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
