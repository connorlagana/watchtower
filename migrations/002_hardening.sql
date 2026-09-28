-- Abuse/cost controls, noise suppression, webhooks, retention.

-- Per-host politeness and caps need the host as a column.
ALTER TABLE resources ADD COLUMN host text;
UPDATE resources SET host = lower(substring(url FROM '^[a-z]+://\[?([^/:?#\]]+)'));
ALTER TABLE resources ALTER COLUMN host SET NOT NULL;
CREATE INDEX resources_host_idx ON resources (host);

-- Learned per-line volatility: { "observed": n, "sigs": { "<signature>": changes } }.
ALTER TABLE resources ADD COLUMN line_stats jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Cluster-wide per-host lease: at most one in-flight fetch per host, with spacing between fetches.
CREATE TABLE host_leases (
  host         text PRIMARY KEY,
  leased_until timestamptz NOT NULL
);

-- Watches expire when their owner stops reading them.
ALTER TABLE watches ADD COLUMN last_accessed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE watches ADD COLUMN delete_reason text;
-- Optional push delivery.
ALTER TABLE watches ADD COLUMN webhook_url text;
ALTER TABLE watches ADD COLUMN webhook_secret text;

CREATE TABLE webhook_deliveries (
  id              bigserial PRIMARY KEY,
  watch_id        uuid NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Shared (cross-replica) fixed-window rate limiting.
CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Retention sweeps.
CREATE INDEX changes_detected_idx ON changes (detected_at);
CREATE INDEX snapshots_fetched_idx ON snapshots (fetched_at);
CREATE INDEX watches_deleted_idx ON watches (deleted_at) WHERE deleted_at IS NOT NULL;
