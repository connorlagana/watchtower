-- Watchtower initial schema.
--
-- Resources are the things we fetch (one row per canonical URL + selector).
-- Watches are what clients ask for; many watches can point at one resource,
-- so N agents watching the same page cost one fetch.

CREATE TABLE clients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,          -- sha256 of the bearer token; the token itself is never stored
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resources (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url                  text NOT NULL,           -- the URL actually fetched (after adapter mapping)
  selector             text NOT NULL DEFAULT '',-- optional CSS selector narrowing the compared region
  adapter              text NOT NULL,           -- html | greenhouse | lever
  etag                 text,
  last_modified        text,
  current_snapshot_id  uuid,
  last_checked_at      timestamptz,
  last_changed_at      timestamptz,
  last_status          integer,
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  next_check_at        timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (url, selector, adapter)
);

CREATE INDEX resources_due_idx ON resources (next_check_at);

-- A snapshot is only written when the content hash changes.
CREATE TABLE snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  status_code  integer NOT NULL,
  content_type text,
  content_hash text NOT NULL,                  -- sha256 over normalized text + structured data
  text_hash    text NOT NULL,                  -- sha256 over normalized text only
  title        text,
  text         text NOT NULL,                  -- normalized, truncated text used for diffs
  structured   jsonb NOT NULL DEFAULT '{}'::jsonb  -- { jobs: [...], events: [...] }
);

CREATE INDEX snapshots_resource_idx ON snapshots (resource_id, fetched_at DESC);

ALTER TABLE resources
  ADD CONSTRAINT resources_current_snapshot_fk
  FOREIGN KEY (current_snapshot_id) REFERENCES snapshots(id) ON DELETE SET NULL;

-- Change events are resource-level facts. Watches read them through their own
-- type/keyword filters, so fan-out costs nothing at write time.
CREATE TABLE changes (
  id           bigserial PRIMARY KEY,          -- monotonically increasing; doubles as a cursor
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  snapshot_id  uuid REFERENCES snapshots(id) ON DELETE SET NULL,
  type         text NOT NULL,                  -- CONTENT_CHANGED | JOB_ADDED | JOB_REMOVED | JOB_UPDATED | EVENT_ADDED | ...
  item_key     text,
  summary      text NOT NULL,
  data         jsonb NOT NULL,
  search_text  text NOT NULL DEFAULT '',       -- lowercased text keyword filters match against
  detected_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX changes_resource_idx ON changes (resource_id, id);

CREATE TABLE watches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  resource_id      uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('url', 'jobs', 'events')),
  source_url       text NOT NULL,              -- the URL the client gave us
  label            text,
  keywords         text[] NOT NULL DEFAULT '{}',
  change_types     text[] NOT NULL,
  interval_seconds integer NOT NULL,
  baseline         bigint NOT NULL DEFAULT 0,  -- max change id when the watch was created; earlier changes are never shown
  cursor           bigint NOT NULL DEFAULT 0,  -- last change id delivered by get_changes
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE INDEX watches_client_idx ON watches (client_id) WHERE deleted_at IS NULL;
CREATE INDEX watches_resource_idx ON watches (resource_id) WHERE deleted_at IS NULL;
