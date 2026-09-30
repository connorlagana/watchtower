-- Structured job filters per watch, evaluated against the change's job data.
ALTER TABLE watches
  ADD COLUMN exclude_keywords text[] NOT NULL DEFAULT '{}',
  ADD COLUMN locations        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN seniority        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN remote_only      boolean NOT NULL DEFAULT false;
