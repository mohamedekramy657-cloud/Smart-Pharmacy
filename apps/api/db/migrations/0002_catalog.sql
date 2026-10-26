-- 0002_catalog.sql — central medicine catalog.
-- Identity is NEVER the display name: identity_key = brand + ingredient strengths + dosage form +
-- route + package + manufacturer (computed by the application, unique in the DB).

CREATE TABLE active_ingredients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_en         text NOT NULL CHECK (length(name_en) BETWEEN 2 AND 160),
  name_ar         text,
  normalized_name text GENERATED ALWAYS AS (sp_normalize_text(name_en)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX active_ingredients_normalized_uq ON active_ingredients (normalized_name);

CREATE TABLE medicines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_name_en       text NOT NULL CHECK (length(brand_name_en) BETWEEN 1 AND 160),
  brand_name_ar       text,
  generic_name_en     text NOT NULL,
  generic_name_ar     text,
  strength            text NOT NULL,          -- display, e.g. "500 mg" or "500 mg + 65 mg"
  concentration       text,                   -- e.g. "250 mg/5 mL" for liquids
  dosage_form         text NOT NULL CHECK (dosage_form IN (
                        'TABLET','FILM_COATED_TABLET','EFFERVESCENT_TABLET','CHEWABLE_TABLET',
                        'EXTENDED_RELEASE_TABLET','CAPSULE','SYRUP','SUSPENSION','ORAL_DROPS','SOLUTION',
                        'INJECTION','INFUSION','CREAM','OINTMENT','GEL','EYE_DROPS','EAR_DROPS',
                        'NASAL_SPRAY','INHALER','SUPPOSITORY','SACHET','POWDER','LOZENGE','PATCH','OTHER')),
  route               text NOT NULL CHECK (route IN (
                        'ORAL','TOPICAL','INTRAVENOUS','INTRAMUSCULAR','SUBCUTANEOUS','OPHTHALMIC','OTIC',
                        'NASAL','INHALATION','RECTAL','VAGINAL','SUBLINGUAL','TRANSDERMAL','OTHER')),
  package_size        numeric(10, 2) NOT NULL CHECK (package_size > 0),
  package_unit        text NOT NULL CHECK (package_unit IN (
                        'TABLET','CAPSULE','ML','G','AMPOULE','VIAL','SACHET','SUPPOSITORY','DOSE','PATCH','UNIT')),
  manufacturer        text NOT NULL,
  barcode             text CHECK (barcode ~ '^[0-9]{8,14}$'),
  registration_number text,
  category            text,
  prescription_class  text NOT NULL DEFAULT 'PRESCRIPTION' CHECK (prescription_class IN ('OTC', 'PRESCRIPTION', 'CONTROLLED')),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISCONTINUED', 'RECALLED', 'SUSPENDED')),
  status_reason       text,
  status_changed_at   timestamptz,
  status_changed_by   uuid REFERENCES users(id),
  image_url           text CHECK (image_url IS NULL OR image_url ~ '^https://'),
  image_license       text,
  identity_key        text NOT NULL,
  data_source         text NOT NULL DEFAULT 'MANUAL' CHECK (data_source IN ('MANUAL', 'DEV_SEED', 'REGULATOR_IMPORT')),
  created_by          uuid REFERENCES users(id),
  updated_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (image_url IS NULL OR image_license IS NOT NULL)
);
CREATE UNIQUE INDEX medicines_identity_uq ON medicines (identity_key);
CREATE UNIQUE INDEX medicines_barcode_uq ON medicines (barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX medicines_registration_uq ON medicines (registration_number) WHERE registration_number IS NOT NULL;
CREATE INDEX medicines_status_idx ON medicines (status);
CREATE TRIGGER medicines_touch BEFORE UPDATE ON medicines FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE medicine_ingredients (
  medicine_id    uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  ingredient_id  uuid NOT NULL REFERENCES active_ingredients(id),
  strength_value numeric(14, 4) NOT NULL CHECK (strength_value > 0),
  strength_unit  text NOT NULL CHECK (strength_unit IN (
                   'MG','G','MCG','IU','ML','PERCENT','MG_PER_ML','MG_PER_5ML','MCG_PER_DOSE','UNIT')),
  PRIMARY KEY (medicine_id, ingredient_id)
);
CREATE INDEX medicine_ingredients_ingredient_idx ON medicine_ingredients (ingredient_id);

CREATE TABLE medicine_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  alias       text NOT NULL CHECK (length(alias) BETWEEN 2 AND 120),
  language    text NOT NULL CHECK (language IN ('ar', 'en', 'translit')),
  approved    boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (medicine_id, alias)
);

-- Denormalized search index, rebuilt by triggers whenever names, ingredients or aliases change.
CREATE TABLE medicine_search_terms (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  medicine_id     uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('BRAND', 'GENERIC', 'INGREDIENT', 'ALIAS')),
  term            text NOT NULL,
  term_normalized text NOT NULL,
  term_skeleton   text NOT NULL,
  weight          real NOT NULL
);
CREATE INDEX medicine_search_terms_norm_trgm ON medicine_search_terms USING gin (term_normalized gin_trgm_ops);
CREATE INDEX medicine_search_terms_skel_trgm ON medicine_search_terms USING gin (term_skeleton gin_trgm_ops);
CREATE INDEX medicine_search_terms_medicine_idx ON medicine_search_terms (medicine_id);

CREATE OR REPLACE FUNCTION sp_rebuild_medicine_search_terms(p_medicine uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM medicine_search_terms WHERE medicine_id = p_medicine;
  -- Medicines are never hard-deleted in normal operation (use status), but stay safe under CASCADE.
  IF NOT EXISTS (SELECT 1 FROM medicines WHERE id = p_medicine) THEN RETURN; END IF;
  INSERT INTO medicine_search_terms (medicine_id, kind, term, term_normalized, term_skeleton, weight)
  SELECT p_medicine, s.kind, s.term, sp_normalize_text(s.term), sp_search_skeleton(s.term), s.weight
  FROM (
    SELECT 'BRAND' AS kind, m.brand_name_en AS term, 1.0::real AS weight FROM medicines m WHERE m.id = p_medicine
    UNION ALL SELECT 'BRAND', m.brand_name_ar, 1.0 FROM medicines m WHERE m.id = p_medicine
    UNION ALL SELECT 'GENERIC', m.generic_name_en, 0.9 FROM medicines m WHERE m.id = p_medicine
    UNION ALL SELECT 'GENERIC', m.generic_name_ar, 0.9 FROM medicines m WHERE m.id = p_medicine
    UNION ALL SELECT 'INGREDIENT', ai.name_en, 0.85 FROM medicine_ingredients mi
              JOIN active_ingredients ai ON ai.id = mi.ingredient_id WHERE mi.medicine_id = p_medicine
    UNION ALL SELECT 'INGREDIENT', ai.name_ar, 0.85 FROM medicine_ingredients mi
              JOIN active_ingredients ai ON ai.id = mi.ingredient_id WHERE mi.medicine_id = p_medicine
    UNION ALL SELECT 'ALIAS', a.alias, 0.8 FROM medicine_aliases a WHERE a.medicine_id = p_medicine AND a.approved
  ) s
  WHERE s.term IS NOT NULL AND btrim(s.term) <> '';
END $$;

CREATE OR REPLACE FUNCTION sp_trg_medicine_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'medicines' THEN
    PERFORM sp_rebuild_medicine_search_terms(NEW.id);
  ELSIF TG_TABLE_NAME = 'active_ingredients' THEN
    PERFORM sp_rebuild_medicine_search_terms(mi.medicine_id)
      FROM medicine_ingredients mi WHERE mi.ingredient_id = NEW.id;
  ELSE
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM sp_rebuild_medicine_search_terms(NEW.medicine_id); END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM sp_rebuild_medicine_search_terms(OLD.medicine_id); END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER medicines_terms AFTER INSERT OR UPDATE OF brand_name_en, brand_name_ar, generic_name_en, generic_name_ar
  ON medicines FOR EACH ROW EXECUTE FUNCTION sp_trg_medicine_terms();
CREATE TRIGGER medicine_ingredients_terms AFTER INSERT OR UPDATE OR DELETE
  ON medicine_ingredients FOR EACH ROW EXECUTE FUNCTION sp_trg_medicine_terms();
CREATE TRIGGER medicine_aliases_terms AFTER INSERT OR UPDATE OR DELETE
  ON medicine_aliases FOR EACH ROW EXECUTE FUNCTION sp_trg_medicine_terms();
CREATE TRIGGER active_ingredients_terms AFTER UPDATE OF name_en, name_ar
  ON active_ingredients FOR EACH ROW EXECUTE FUNCTION sp_trg_medicine_terms();
