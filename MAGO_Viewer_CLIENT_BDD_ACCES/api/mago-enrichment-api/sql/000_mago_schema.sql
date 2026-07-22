-- ============================================================================
-- MAGO Viewer - clean public schema for mago_enrichment
--
-- This file creates only the technical structure required by MAGO Viewer.
-- It contains no project, scene, client, mesh, point cloud or survey data.
-- It is idempotent and may be executed again during an update.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS mago_class (
    id            SERIAL PRIMARY KEY,
    class_key     TEXT NOT NULL UNIQUE,
    label         INTEGER NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    family        TEXT NOT NULL DEFAULT 'Autre',
    mode          TEXT NOT NULL DEFAULT 'mixte',
    color_hex     TEXT NOT NULL DEFAULT '#9CA3AF',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    survey_type   TEXT NOT NULL DEFAULT 'interieur',
    description   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS object (
    id            SERIAL PRIMARY KEY,
    model_id      INTEGER NOT NULL REFERENCES model(id) ON DELETE CASCADE,
    class_id      INTEGER NOT NULL REFERENCES mago_class(id) ON DELETE RESTRICT,
    object_key    TEXT NOT NULL,
    name          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_object_model_key UNIQUE (model_id, object_key)
);

CREATE TABLE IF NOT EXISTS attribute (
    id            SERIAL PRIMARY KEY,
    object_id     INTEGER NOT NULL REFERENCES object(id) ON DELETE CASCADE,
    attr_key      TEXT NOT NULL,
    attr_label    TEXT NOT NULL,
    data_type     TEXT NOT NULL DEFAULT 'text',
    value         TEXT,
    unit          TEXT,
    options       TEXT,
    position      INTEGER NOT NULL DEFAULT 50,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_attribute_object_key UNIQUE (object_id, attr_key)
);

CREATE INDEX IF NOT EXISTS idx_object_model_id ON object(model_id);
CREATE INDEX IF NOT EXISTS idx_object_class_id ON object(class_id);
CREATE INDEX IF NOT EXISTS idx_attribute_object_id ON attribute(object_id);
CREATE INDEX IF NOT EXISTS idx_mago_class_mode_family ON mago_class(mode, family, label);

CREATE OR REPLACE FUNCTION mago_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mago_class_touch_updated_at ON mago_class;
CREATE TRIGGER mago_class_touch_updated_at
BEFORE UPDATE ON mago_class
FOR EACH ROW EXECUTE FUNCTION mago_touch_updated_at();

DROP TRIGGER IF EXISTS model_touch_updated_at ON model;
CREATE TRIGGER model_touch_updated_at
BEFORE UPDATE ON model
FOR EACH ROW EXECUTE FUNCTION mago_touch_updated_at();

DROP TRIGGER IF EXISTS object_touch_updated_at ON object;
CREATE TRIGGER object_touch_updated_at
BEFORE UPDATE ON object
FOR EACH ROW EXECUTE FUNCTION mago_touch_updated_at();

DROP TRIGGER IF EXISTS attribute_touch_updated_at ON attribute;
CREATE TRIGGER attribute_touch_updated_at
BEFORE UPDATE ON attribute
FOR EACH ROW EXECUTE FUNCTION mago_touch_updated_at();

-- Creates the canonical object for one class in one model.
-- No business/project attributes are seeded: a clean installation starts empty.
CREATE OR REPLACE FUNCTION f_instantiate_object(
    p_model_id INTEGER,
    p_class_key TEXT
)
RETURNS INTEGER AS $$
DECLARE
    v_class_id INTEGER;
    v_display_name TEXT;
    v_object_id INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM model WHERE id = p_model_id) THEN
        RAISE EXCEPTION 'Model % does not exist', p_model_id;
    END IF;

    SELECT id, display_name
      INTO v_class_id, v_display_name
      FROM mago_class
     WHERE lower(class_key) = lower(p_class_key)
     LIMIT 1;

    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Unknown MAGO class: %', p_class_key;
    END IF;

    INSERT INTO object(model_id, class_id, object_key, name)
    VALUES (p_model_id, v_class_id, p_class_key, v_display_name)
    ON CONFLICT (model_id, object_key)
    DO UPDATE SET class_id = EXCLUDED.class_id,
                  name = COALESCE(object.name, EXCLUDED.name)
    RETURNING id INTO v_object_id;

    RETURN v_object_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;

SELECT
    to_regclass('public.mago_class') AS mago_class,
    to_regclass('public.model') AS model,
    to_regclass('public.object') AS object,
    to_regclass('public.attribute') AS attribute;
