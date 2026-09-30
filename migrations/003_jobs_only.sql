-- Watchtower is now job-board monitoring only.

-- Page and event watches can no longer be served; retire them.
UPDATE watches SET deleted_at = now(), delete_reason = 'unsupported_kind'
 WHERE kind <> 'jobs' AND deleted_at IS NULL;

-- Snapshots hold the job list only; page text and learned line noise are gone.
ALTER TABLE snapshots DROP COLUMN title, DROP COLUMN text, DROP COLUMN text_hash;
ALTER TABLE resources DROP COLUMN line_stats;
