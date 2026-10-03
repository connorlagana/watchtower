-- Where each client came from, so the operator can tell which listing or install path brings agents in.
-- source is the ?ref= tag on the URL the client was created through (e.g. /mcp?ref=smithery); user_agent is
-- the creating request's User-Agent, truncated.
ALTER TABLE clients ADD COLUMN source text;
ALTER TABLE clients ADD COLUMN user_agent text;
