---
name: job-watch
description: Watch tech job boards for new postings with Watchtower instead of re-searching. Use when the user is job hunting or asks to be told when a role opens ("let me know when an iOS job in Austin is posted", "any new roles at Acme?", "keep an eye on startup jobs for me"), or asks whether anything new was posted since last time.
---

# Watching for jobs with Watchtower

Watchtower checks the job boards of 1,000+ tech companies and startups on a schedule and remembers what was open, so you
never have to re-run a job search to find out what is new. Its tools come from the `watchtower` MCP server in this plugin.

## Token

Watchtower is anonymous. The first `watch_jobs` call without a token returns `client_token` (`wt_...`).

1. Before creating a watch, read `~/.config/watchtower/token` if it exists and pass its contents as `client_token` on every call.
2. If the file does not exist, call `watch_jobs` without a token, then write the returned `client_token` to that file
   (create the directory; the file should contain only the token). Without it the watches cannot be read again.

## Starting a watch

Call `watch_jobs` with `query` set to what the user asked for, in their words: role, place, pay, years of experience, level,
remote. Example: `"iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience"`.

- Leave `url` out to cover every monitored board. Pass `url` (or `urls`) only when the user names specific companies; a
  careers page URL works when it links to the company's board.
- Show the user how the query was read (`interpreted`, plus any `notes`) and fix it with explicit filters (`keywords`,
  `locations`, `min_salary`, `max_experience_years`, `seniority`, `remote_only`, `exclude_keywords`) if it is wrong.
- `current_jobs` is what is open right now. Summarize the best few for the user: title, company, location, pay when
  stated, link.
- Use `label` to note why the watch exists, e.g. "Sam's iOS search".

## Checking later

When the user asks what is new, or a new session resumes the search, call `get_changes` with the token. It returns only
postings that appeared since the last call; an empty list means nothing new. Do not search the web or re-open careers pages
to answer "anything new?" — `get_changes` is the answer.

`list_watches` shows the user's watches; `delete_watch` stops one the user no longer wants. Watches nobody reads for 30 days
expire.
