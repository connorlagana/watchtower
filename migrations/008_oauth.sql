-- OAuth for MCP connections, so the client's token lives in the connection settings and never passes through a chat.
--
-- oauth_clients: apps registered through dynamic client registration (ChatGPT, Claude, ...). Public clients with PKCE; no secrets.
-- oauth_codes: single-use authorization codes, valid for a few minutes. Only their hash is stored.
-- client_tokens: further bearer tokens for a Watchtower client, one per OAuth grant. Like clients.token_hash, only the hash is stored.
CREATE TABLE oauth_clients (
  id            text PRIMARY KEY,
  client_name   text,
  redirect_uris text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  code_hash       text PRIMARY KEY,
  oauth_client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  expires_at      timestamptz NOT NULL
);

CREATE TABLE client_tokens (
  token_hash      text PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  oauth_client_id text REFERENCES oauth_clients(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_tokens_client_idx ON client_tokens (client_id);
