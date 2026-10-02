-- Search watches: a watch with no board URL that matches new postings across
-- every board Watchtower monitors, plus salary / experience filters.

-- Boards Watchtower monitors on its own (the directory), whether or not a client watches them.
-- index_origin says how a board got there: 'directory' (the built-in list or the operator's file, kept in
-- sync at startup) or 'watched' (a board a client watched by URL, kept so every search watch covers it).
ALTER TABLE resources ADD COLUMN indexed boolean NOT NULL DEFAULT false;
ALTER TABLE resources ADD COLUMN index_origin text CHECK (index_origin IN ('directory', 'watched'));
CREATE INDEX resources_indexed_idx ON resources (next_check_at) WHERE indexed;

-- A search watch has no resource: it reads the changes of every monitored board.
ALTER TABLE watches ALTER COLUMN resource_id DROP NOT NULL;
ALTER TABLE watches ALTER COLUMN source_url DROP NOT NULL;
ALTER TABLE watches DROP CONSTRAINT watches_kind_check;
ALTER TABLE watches ADD CONSTRAINT watches_kind_check CHECK (kind IN ('url', 'jobs', 'events', 'search'));
ALTER TABLE watches ADD CONSTRAINT watches_scope_check CHECK ((kind = 'search') = (resource_id IS NULL));
CREATE INDEX watches_search_idx ON watches (client_id) WHERE resource_id IS NULL AND deleted_at IS NULL;

ALTER TABLE watches
  ADD COLUMN query                text,                            -- the plain-language request the filters were read from
  ADD COLUMN all_keywords         text[] NOT NULL DEFAULT '{}',    -- every one must match (keywords: any one)
  ADD COLUMN min_salary           integer,                         -- annual; the job's stated range must reach it
  ADD COLUMN salary_currency      text,
  ADD COLUMN max_experience_years integer,                         -- the job must ask for at most this many years
  ADD COLUMN include_unknown      boolean NOT NULL DEFAULT true;   -- keep jobs that do not state salary / experience

-- Whole-word match of a (lowercased) term in (lowercased) text, allowing a plural:
-- "ios" matches "Senior iOS Engineer" but not "Studios"; "java" does not match "JavaScript".
-- Mirrors termMatch() in src/extract/match.ts.
CREATE FUNCTION wt_term_match(hay text, term text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT hay ~ ('(^|[^[:alnum:]])' || regexp_replace(term, '([^[:alnum:][:space:]])', '\\\1', 'g') || '(s|es)?($|[^[:alnum:]])') $$;
