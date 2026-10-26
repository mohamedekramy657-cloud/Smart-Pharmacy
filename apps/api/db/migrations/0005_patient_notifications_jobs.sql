-- 0005_patient_notifications_jobs.sql — confirmation requests & holds, alerts, notifications,
-- PostgreSQL job queue (transactional outbox), privacy-preserving search analytics, default settings.

CREATE TABLE stock_reservations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id       uuid NOT NULL REFERENCES inventory_items(id),
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  medicine_id             uuid NOT NULL REFERENCES medicines(id),
  quantity                integer NOT NULL CHECK (quantity > 0),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FULFILLED', 'CANCELLED', 'EXPIRED')),
  purpose                 text NOT NULL DEFAULT 'PATIENT_HOLD' CHECK (purpose IN ('PATIENT_HOLD')),
  confirmation_request_id uuid,
  pickup_code             text NOT NULL,
  expires_at              timestamptz NOT NULL,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  close_reason            text
);
CREATE INDEX stock_reservations_expiry_idx ON stock_reservations (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX stock_reservations_org_idx ON stock_reservations (organization_id, status);

CREATE TABLE stock_confirmation_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code    text NOT NULL UNIQUE,
  patient_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pharmacy_org_id   uuid NOT NULL REFERENCES organizations(id),
  medicine_id       uuid NOT NULL REFERENCES medicines(id),
  requested_qty     integer NOT NULL CHECK (requested_qty BETWEEN 1 AND 100),
  wants_hold        boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                      'PENDING', 'CONFIRMED_AVAILABLE', 'NOT_AVAILABLE', 'HELD', 'EXPIRED', 'CANCELLED')),
  response_note     text,
  responded_by      uuid REFERENCES users(id),
  responded_at      timestamptz,
  reservation_id    uuid REFERENCES stock_reservations(id),
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_confirmation_requests_pharmacy_idx ON stock_confirmation_requests (pharmacy_org_id, status, created_at DESC);
CREATE INDEX stock_confirmation_requests_patient_idx ON stock_confirmation_requests (patient_user_id, created_at DESC);
CREATE INDEX stock_confirmation_requests_expiry_idx ON stock_confirmation_requests (expires_at) WHERE status = 'PENDING';
CREATE TRIGGER stock_confirmation_requests_touch BEFORE UPDATE ON stock_confirmation_requests FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

-- Alert locations are stored rounded (~110 m) by the application; never precise GPS fixes.
CREATE TABLE availability_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_id       uuid NOT NULL REFERENCES medicines(id),
  min_qty           integer NOT NULL DEFAULT 1 CHECK (min_qty BETWEEN 1 AND 100),
  location          geography(Point, 4326) NOT NULL,
  radius_km         numeric(5, 1) NOT NULL CHECK (radius_km > 0 AND radius_km <= 100),
  area_label        text,
  channels          text[] NOT NULL DEFAULT ARRAY['IN_APP'],
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'TRIGGERED', 'PAUSED', 'CANCELLED', 'EXPIRED')),
  last_triggered_at timestamptz,
  trigger_count     integer NOT NULL DEFAULT 0,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (channels <@ ARRAY['IN_APP', 'EMAIL', 'SMS']::text[])
);
CREATE INDEX availability_alerts_medicine_idx ON availability_alerts (medicine_id) WHERE status = 'ACTIVE';
CREATE INDEX availability_alerts_location_gix ON availability_alerts USING gist (location) WHERE status = 'ACTIVE';
CREATE INDEX availability_alerts_user_idx ON availability_alerts (user_id, created_at DESC);
CREATE TRIGGER availability_alerts_touch BEFORE UPDATE ON availability_alerts FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

CREATE TABLE notification_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app_enabled boolean NOT NULL DEFAULT true,
  email_enabled  boolean NOT NULL DEFAULT false,
  sms_enabled    boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type            text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('EMAIL', 'SMS', 'PUSH')),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  provider        text,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel)
);

-- Job queue. Rows are inserted inside business transactions (outbox) and processed after commit.
CREATE TABLE jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX jobs_status_idx ON jobs (status, updated_at DESC);
CREATE UNIQUE INDEX jobs_dedupe_active_uq ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('PENDING', 'RUNNING', 'FAILED');
CREATE TRIGGER jobs_touch BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION sp_touch_updated_at();

-- Privacy: no user id, no precise coordinates. area_cell is a ~1.1 km grid cell.
CREATE TABLE search_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  medicine_id        uuid,
  requested_qty      integer,
  outcome            text NOT NULL,
  matched_radius_km  numeric(6, 1),
  searched_radius_km numeric(6, 1),
  result_count       integer NOT NULL DEFAULT 0,
  confirmed_count    integer NOT NULL DEFAULT 0,
  latency_ms         integer NOT NULL,
  area_cell          text,
  location_method    text
);
CREATE INDEX search_events_time_idx ON search_events (occurred_at DESC);

-- Default platform settings (validated by the application on every write).
INSERT INTO system_settings (key, value, description) VALUES
 ('finder.radiiKm', '[5, 10, 20, 40]', 'Progressive search distance bands in km (ascending).'),
 ('finder.maxRadiusKm', '40', 'Maximum patient search distance in km.'),
 ('finder.maxCandidates', '300', 'Upper bound of candidate listings fetched by the single spatial query.'),
 ('finder.resultLimit', '20', 'Maximum ranked results returned to the patient.'),
 ('finder.includeControlled', 'false', 'Whether CONTROLLED medicines show availability publicly (legal review required).'),
 ('finder.showPrices', 'false', 'Whether verified prices are displayed to patients.'),
 ('finder.showExactQuantities', 'false', 'Whether patients see exact available quantities (otherwise buckets).'),
 ('finder.showStaleSection', 'true', 'Whether stale listings are shown in a separate, clearly labeled section.'),
 ('ranking.preferOpenNow', 'true', 'Within the same availability tier, rank pharmacies open now before closed ones.'),
 ('freshness.bySource', '{"INTEGRATION":{"confirmedMinutes":120,"staleMinutes":1440},"MANUAL":{"confirmedMinutes":720,"staleMinutes":4320},"BARCODE":{"confirmedMinutes":720,"staleMinutes":4320},"RECEIPT":{"confirmedMinutes":720,"staleMinutes":4320},"SYSTEM":{"confirmedMinutes":720,"staleMinutes":4320},"CSV_IMPORT":{"confirmedMinutes":1440,"staleMinutes":10080}}', 'Freshness windows per update source.'),
 ('requests.responseTimeoutMinutes', '120', 'Pending stock confirmation requests expire after this time.'),
 ('requests.maxPendingPerPatient', '5', 'Maximum simultaneous pending confirmation requests per patient.'),
 ('holds.defaultMinutes', '60', 'Default hold duration when a pharmacy holds stock for a patient.'),
 ('holds.maxMinutes', '240', 'Maximum hold duration.'),
 ('alerts.defaultExpiryDays', '30', 'Availability alerts expire after this many days.'),
 ('alerts.maxActivePerUser', '10', 'Maximum active availability alerts per user.'),
 ('receiving.quarantineOnReceipt', 'false', 'If true, received goods go to unavailable (QC hold) until released.'),
 ('inventory.expiryAlertDays', '60', 'Warn about batches expiring within this many days.'),
 ('integrations.failingAfterFailures', '3', 'Consecutive failures after which an integration is FAILING.'),
 ('integrations.staleAfterIntervals', '3', 'Missed expected intervals after which an integration is STALE.')
ON CONFLICT (key) DO NOTHING;

-- Generic request idempotency: written in the SAME transaction as the business operation, so a
-- replay (same scope + key + payload) returns the original response and never re-applies effects.
CREATE TABLE idempotency_records (
  scope           text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    text NOT NULL,
  response        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idempotency_key)
);
CREATE INDEX idempotency_records_created_idx ON idempotency_records (created_at);
