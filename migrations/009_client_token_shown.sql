-- Whether anyone ever received the client's own token. A client created by an OAuth consent is reachable only through
-- its connection tokens (client_tokens); once it has none, because the connection moved to an older client or the
-- code was never exchanged, nobody can use it and it is deleted instead of being counted as a user on /stats.
ALTER TABLE clients ADD COLUMN token_shown boolean NOT NULL DEFAULT true;
UPDATE clients SET token_shown = false WHERE source = 'oauth';
