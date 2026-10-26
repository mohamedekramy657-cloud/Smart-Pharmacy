-- 0001_foundation.sql
-- Extensions, shared helper functions, geography reference data, identity & organizations,
-- settings, audit and security event logs.
-- NOTE: postgis is not a "trusted" extension; on managed databases it must be created by a
-- privileged role before running migrations. The IF NOT EXISTS makes this a no-op then.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- Normalizes Arabic/English text for search: lowercases, strips Latin accents, Arabic
-- diacritics (tashkeel) and tatweel, unifies alef/ya/ta-marbuta/hamza-carrier variants,
-- converts Arabic-Indic digits, removes punctuation and collapses whitespace.
CREATE OR REPLACE FUNCTION sp_normalize_text(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(
             translate(
               regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, input)),
                              '[\u064B-\u065F\u0670\u0640]', '', 'g'),
               'أإآٱةىؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
               'ااااهيوي01234567890123456789'),
             '[^0-9a-z\u0621-\u064A.]+', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;

-- Phonetic "consonant skeleton" used ONLY for candidate retrieval (never for identity):
-- Arabic letters are mapped to Egyptian-convention Latin approximations, Latin spelling
-- variants are folded (ph->f, x->ks, c->k/s, p->b, v->f, j->g, e/y->i, u/w->o), inner vowels are
-- dropped and doubled letters collapsed. E.g. 'Panadol' and 'بانادول' both -> 'bndl'.
CREATE OR REPLACE FUNCTION sp_search_skeleton(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT AS $$
DECLARE t text;
BEGIN
  t := sp_normalize_text(input);
  t := replace(replace(replace(t, 'ش', 'sh'), 'خ', 'kh'), 'غ', 'gh');
  t := translate(t, 'ابتثجحدذرزسصضطظعفقكلمنهويء', 'abtsghdzrzssdtzafkklmnhoi');
  t := replace(replace(t, 'ph', 'f'), 'x', 'ks');
  t := regexp_replace(t, 'c([eiy])', 's\1', 'g');
  t := translate(t, 'pvqcyewuj', 'bfkkiioog');
  t := regexp_replace(t, '\Y[aio]', '', 'g');
  t := regexp_replace(t, '([a-z])\1+', '\1', 'g');
  RETURN btrim(regexp_replace(t, '\s+', ' ', 'g'));
END $$;

CREATE OR REPLACE FUNCTION sp_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Used to make ledger / audit tables append-only.
CREATE OR REPLACE FUNCTION sp_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

-- ---------------------------------------------------------------------------
-- Geography reference (cities/districts with approximate centroids for location selection)
-- ---------------------------------------------------------------------------
CREATE TABLE cities (
  id            serial PRIMARY KEY,
  governorate_en text NOT NULL,
  governorate_ar text NOT NULL,
  name_en       text NOT NULL,
  name_ar       text NOT NULL,
  centroid      geography(Point, 4326) NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (governorate_en, name_en)
);

CREATE TABLE districts (
  id        serial PRIMARY KEY,
  city_id   integer NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name_en   text NOT NULL,
  name_ar   text NOT NULL,
  centroid  geography(Point, 4326) NOT NULL,
  UNIQUE (city_id, name_en)
);

-- ---------------------------------------------------------------------------
-- Users & sessions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  phone              text,
  full_name          text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  password_hash      text NOT NULL,
  platform_role      text NOT NULL DEFAULT 'USER' CHECK (platform_role IN ('USER', 'SUPER_ADMIN')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  preferred_locale   text NOT NULL DEFAULT 'ar' CHECK (preferred_locale IN ('ar', 'en')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  mfa_enabled        boolean NOT NULL DEFAULT false,
  mfa_secret_enc     text,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          bytea NOT NULL UNIQUE,
  mfa_verified        boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  ip_hash             text,
  user_agent          text
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Organizations (pharmacies & warehouses share identity, location and verification)
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                text NOT NULL CHECK (type IN ('PHARMACY', 'WAREHOUSE')),
  name_en             text NOT NULL CHECK (length(name_en) BETWEEN 2 AND 160),
  name_ar             text,
  legal_name          text,
  registration_number text,
  license_number      text,
  tax_id              text,
  address_line        text NOT NULL,
  city_id             integer REFERENCES cities(id),
  district_id         integer REFERENCES districts(id),
  location            geography(Point, 4326) NOT NULL,
  phone               text,
  email               text,
  timezone            text NOT NULL DEFAULT 'Africa/Cairo',
  verification_status text NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  verified_at         timestamptz,
  verified_by         uuid REFERENCES users(id),
  suspended_at        timestamptz,
  suspension_reason   text,
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_license_uq ON organizations (type, license_number) WHERE license_number IS NOT NULL;
CREATE INDEX organizations_type_status_idx ON organizations (type, verification_status, status);
CREATE INDEX organizations_location_gix ON organizations USING gist (location);
-- Partial spatial index containing only pharmacies eligible for patient search.
CREATE INDEX organizations_searchable_pharmacy_gix ON organizations USING gist (location)
  WHERE type = 'PHARMACY' AND verification_status = 'VERIFIED' AND status = 'ACTIVE';
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE pharmacies (
  organization_id                    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  is_24h                             boolean NOT NULL DEFAULT false,
  delivery_available                 boolean NOT NULL DEFAULT false,
  accepts_confirmation_requests      boolean NOT NULL DEFAULT true,
  accepts_holds                      boolean NOT NULL DEFAULT false,
  pharmacist_in_charge               text,
  -- Per-pharmacy freshness overrides (minutes). NULL = use platform settings for the source.
  freshness_confirmed_minutes        integer CHECK (freshness_confirmed_minutes > 0),
  freshness_stale_minutes            integer CHECK (freshness_stale_minutes > 0),
  CHECK (freshness_confirmed_minutes IS NULL OR freshness_stale_minutes IS NULL
         OR freshness_confirmed_minutes < freshness_stale_minutes)
);

CREATE TABLE warehouses (
  organization_id        uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  default_lead_time_hours integer NOT NULL DEFAULT 48 CHECK (default_lead_time_hours > 0),
  min_order_value        numeric(12, 2) CHECK (min_order_value >= 0),
  cold_chain_capable     boolean NOT NULL DEFAULT false,
  distribution_notes     text
);

CREATE TABLE warehouse_service_areas (
  warehouse_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  city_id          integer NOT NULL REFERENCES cities(id),
  PRIMARY KEY (warehouse_org_id, city_id)
);

-- Opening hours in the organization's local time. closes_at <= opens_at means "past midnight".
CREATE TABLE opening_hours (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day_of_week     smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  opens_at        time NOT NULL,
  closes_at       time NOT NULL,
  PRIMARY KEY (organization_id, day_of_week, opens_at)
);

CREATE TABLE organization_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF', 'ORG_VIEWER')),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id) WHERE status = 'ACTIVE';
CREATE TRIGGER organization_members_touch BEFORE UPDATE ON organization_members FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE verification_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  submitted_by    uuid REFERENCES users(id),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  submission_notes text,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  decision_notes  text
);
CREATE INDEX verification_requests_pending_idx ON verification_requests (submitted_at) WHERE status = 'PENDING';
CREATE UNIQUE INDEX verification_requests_one_pending_uq ON verification_requests (organization_id) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Settings, audit, security
-- ---------------------------------------------------------------------------
CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,
  actor_type      text NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER', 'SYSTEM', 'INTEGRATION')),
  organization_id uuid,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text,
  summary         text,
  changes         jsonb,
  request_id      text,
  ip_hash         text
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_org_idx ON audit_logs (organization_id, occurred_at DESC);
CREATE INDEX audit_logs_time_idx ON audit_logs (occurred_at DESC);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION sp_prevent_mutation();

CREATE TABLE security_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  type        text NOT NULL,
  severity    text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  user_id     uuid,
  ip_hash     text,
  path        text,
  details     jsonb,
  request_id  text
);
CREATE INDEX security_events_time_idx ON security_events (occurred_at DESC);
CREATE INDEX security_events_type_idx ON security_events (type, occurred_at DESC);
