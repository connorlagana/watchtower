-- People who sign in on the website (/jobs). Each person gets a Watchtower client, so a saved search is an ordinary
-- search watch on it and everything the scheduler, get_changes and /stats already do applies unchanged.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,                                  -- scrypt$N$r$p$salt$hash
  client_id     uuid REFERENCES clients(id) ON DELETE SET NULL, -- recreated on demand if maintenance deleted it
  email_alerts  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_alert_at timestamptz
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

-- Browser sessions. Only the hash of the cookie value is stored.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- The last change id an email digest has reported for a watch (NULL: nothing sent yet, start at its baseline).
ALTER TABLE watches ADD COLUMN notified_cursor bigint;
