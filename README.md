# Watchtower

**Tech job monitoring for AI agents. Say what you are looking for once and get only the new postings that match, from the job boards of tech companies and startups, as structured JSON.**

Agents are bad at waiting for a job to be posted. A session lasts minutes, careers pages are heavy to re-read, and "has anyone posted an iOS role in Austin yet?" turns into re-running the same search every day. With Watchtower the agent creates a watch once, in plain language:

```json
{ "query": "iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience" }
```

Watchtower checks the job boards of tech companies and startups on a schedule and remembers which jobs were open. `get_changes` then returns only the new postings that match, and a webhook can wake the agent when one arrives. An agent can also watch one company's board by URL and get `JOB_ADDED`, `JOB_REMOVED` and `JOB_UPDATED` events.

- **No URL needed.** A watch created from a `query` covers every board Watchtower monitors: a built-in directory of tech company and startup boards plus every board anyone has watched by URL.
- **Pay and experience.** Jobs carry `salary` and `experience_years` when the posting states them, and watches filter on `min_salary` and `max_experience_years`.
- **Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Workday and iCIMS** are read through each platform's own endpoints: no bot walls. Any other careers page works if it publishes schema.org `JobPosting` markup.
- **Filters on the watch**, so `get_changes` only returns what matters: `keywords`, `all_keywords`, `exclude_keywords`, `locations`, `seniority`, `remote_only`, `min_salary` and `max_experience_years`. Every job carries derived `remote` and `seniority` fields.
- **Many companies in one call**: pass `urls` instead of `url`.
- **MCP** (Streamable HTTP) and **REST**, backed by the same service layer.
- Free and anonymous: a client gets a token and up to 50 watches (a search across all boards is one watch).
- TypeScript, Node.js 22, Fastify 5, PostgreSQL, the official MCP TypeScript SDK. No LLM or third-party API keys required.

## Quick start

```bash
cp .env.example .env
docker compose up --build          # app on http://localhost:3000, Postgres alongside
docker compose --profile demo run --rm demo   # the end-to-end demo below
```

Without Docker (Node 22 and a running Postgres):

```bash
npm install
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/watchtower
npm run migrate
npm run dev                         # or: npm run build && npm start
```

## Demo

`npm run demo` (with `DATABASE_URL` set) runs the core loop end to end against a local fixture careers page:

1. create client → 2. create a job watch with keyword `ios` (takes the initial snapshot) → 3. a second agent watches the same board and reuses the same resource → 4. a third agent names no board and creates a search watch from "remote iOS jobs paying at least 150k with a maximum of 6 years of experience" → 5. a re-check where only the page around the jobs changed (session token, "N minutes ago") reports no change → 6. the source adds an iOS job and an Android job → 7. Watchtower checks and detects the change → 8. an MCP client calls `get_changes`:

```json
{
  "changes": [
    { "type": "JOB_ADDED",
      "summary": "New job: Senior iOS Engineer (Remote - US)",
      "data": { "job": { "title": "Senior iOS Engineer", "location": "Remote - US", "company": "Acme Robotics", "url": "…/careers/ios-303" } } }
  ],
  "cursor": 2, "has_more": false
}
```

The Android job is filtered out by the keyword. 9. A second `get_changes` call returns `[]`. 10. The second agent, with no keyword, sees both new roles. 11. The third agent gets the iOS role with the salary and experience read from the posting.

The demo runs its fixture on 127.0.0.1, so it turns on `ALLOW_PRIVATE_NETWORKS` for its own process only.

## Connecting an agent (MCP)

```json
{ "mcpServers": { "watchtower": { "type": "http", "url": "http://localhost:3000/mcp" } } }
```

| Tool | What it does |
|---|---|
| `watch_jobs` | With `query` and no URL: watch every monitored board for new postings that match a plain-language request. The result shows the reading (`interpreted`), the matching jobs open now (`current_jobs`) and the boards covered (`coverage`). With `url`, or `urls` (up to 25; returns `watches` and per-URL `errors`): watch specific boards. Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Workday and iCIMS use their own endpoints; other careers pages use schema.org `JobPosting`. A careers page that only links to a supported board is watched through that board (`resolved_from`), and a page with neither is rejected with `NO_JOB_DATA`. Board watches emit `JOB_ADDED` / `JOB_REMOVED` / `JOB_UPDATED`; search watches emit `JOB_ADDED`. Explicit filters override the query: `keywords`, `all_keywords`, `exclude_keywords`, `locations`, `seniority`, `remote_only`, `min_salary`, `salary_currency`, `max_experience_years`, `include_unknown`. |
| `get_changes` | Changes since your last call (the cursor advances). `peek`, `since` (replay), `watch_id`, `limit`. |
| `ack_changes` | Acknowledge a cursor after `get_changes(peek=true)`, for at-least-once processing. |
| `list_watches` | Your watches, with health, expiry and pending-change counts. |
| `get_watch` | One watch plus the jobs currently open that match its filters (across all boards for a search watch). |
| `delete_watch` | Stop monitoring and free a slot. |

`watch_jobs` also accepts `webhook_url` for push delivery (see below).

The tool descriptions and server `instructions` tell agents to prefer Watchtower over re-running job searches or re-checking careers pages.

## Search watches

A watch with no `url` is a search watch. It is its filters, and it reads the new postings of every monitored board.

```bash
curl -s -X POST localhost:3000/v1/watches -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"query":"iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience"}'
```

```json
{
  "scope": "all_boards",
  "interpreted": { "filters": { "keywords": ["ios"], "locations": ["austin"], "min_salary": 150000, "max_experience_years": 6, "include_unknown": true }, "notes": [] },
  "coverage": { "boards": 1061 },
  "matching_jobs_count": 3,
  "current_jobs": [ { "title": "Senior iOS Engineer", "company": "Acme", "location": "Austin, TX", "salary": { "min": 165000, "max": 210000, "currency": "USD", "period": "year", "annual_min": 165000, "annual_max": 210000 }, "experience_years": 5, "url": "…" } ]
}
```

- **The query is read by rules, not a model.** Watchtower still needs no LLM or API key. The reading comes back as `interpreted`, with `notes` for anything it could not use, so the calling agent can check it. Explicit filters always win over the query.
  - Role words become `keywords` (any of, for "iOS or Android") or `all_keywords` (all of, for "data scientist"). Generic words such as "engineer" and "developer" are dropped when a more specific word is present.
  - "in Austin", "in Austin, TX", "in New York or remote" become `locations`. A bare "remote" becomes `remote_only`.
  - "at least 150k", "$180,000+", "$45/hr" become `min_salary`, converted to a yearly figure.
  - "a maximum of 6 years of experience", "3-5 years", "I have 4 years of experience" become `max_experience_years`.
  - "senior", "staff", "entry level" and the other levels become `seniority`. "no managers" becomes `exclude_keywords`.
- **Coverage is tech companies and startups, not the whole internet.** The built-in directory (`src/search/boards.ts`) lists 1,061 company boards on Greenhouse, Lever, Ashby and Workable, from large public tech companies down to seed-stage startups. Each was confirmed against its platform's API with open jobs. Every role those companies post is covered, not only engineering. On top of that, every board any client watches by URL is covered, and stays covered (see [Growing the directory](#growing-the-directory)).
- **Pay and experience come from the posting.** Lever, Ashby, Greenhouse, Recruitee and JSON-LD pay fields are read directly; otherwise the posting text is parsed ("$150,000 - $200,000/yr", "5+ years of experience"). A job passes `min_salary` when the top of its range reaches it, and `max_experience_years` when it asks for no more than that.
- **Postings that state neither are still reported**, without a `salary` or `experience_years` field, because many postings state no pay. Pass `include_unknown: false` to report only postings that state a qualifying value.
- **Only new postings are reported** (`JOB_ADDED`), and only those that appear after the watch was created. `current_jobs` on creation and on `get_watch` is the baseline of what is open now.
- SmartRecruiters, Workday and iCIMS listings carry no posting text, so their jobs never have `salary` or `experience_years`.

### Growing the directory

The directory grows in three ways.

- **Agents grow it by using it.** When a client watches a platform board by URL and it has open jobs, the board joins the directory and stays there after that watch ends, so every search watch covers it from then on. At most `INDEX_MAX_PROMOTED` (5,000) boards are kept this way, and one that fails eight checks in a row is dropped. Arbitrary careers pages are never kept; only boards on the platform APIs.
- **A careers page works as a way in.** `watch_jobs` with `https://acme.com/careers` usually finds no job markup there, because the page only links to or embeds the company's board. Watchtower then reads the page once more, finds the link to a supported board, and watches that board instead. The response says so in `resolved_from`.
- **Operators can import a company list.** `npm run discover -- companies.json boards.txt` takes `[{ "name", "website" }]` and, for each company, reads its careers page for a board link, then tries boards named after the company on Ashby, Greenhouse and Lever. Every candidate is confirmed against the platform's listing API and kept only if it has open jobs. `boards.txt` is in the format `INDEX_BOARDS_FILE` reads. The built-in list was produced this way from the public Y Combinator company directory. A board found by name rather than from the company's own page can belong to a different company with the same name; the `.json` output records how each board was found.

Auth: send `Authorization: Bearer <token>` on the MCP connection, or pass `client_token` as a tool argument. If a `watch_jobs` call arrives with no token, Watchtower creates an anonymous client and returns its token in the result, so an agent can start with zero setup. This draws on the same per-address budget as `POST /v1/clients`.

## REST API

All endpoints except `POST /v1/clients` need `Authorization: Bearer <token>`.

| Method & path | |
|---|---|
| `POST /v1/clients` | Create an anonymous client. Returns `token` (shown once). Rate-limited per address. |
| `POST /v1/watches` | `{ "query"?, "url"? \| "urls"?, "keywords"?, "all_keywords"?, "exclude_keywords"?, "locations"?, "seniority"?, "remote_only"?, "min_salary"?, "salary_currency"?, "max_experience_years"?, "include_unknown"?, "interval_minutes"?, "label"?, "webhook_url"? }`. With neither `url` nor `urls` it creates a search watch across all monitored boards and needs at least one filter (`QUERY_TOO_BROAD` otherwise). With `urls` the response is `{ watches, errors }`. `"type": "jobs"` is accepted for older clients. |
| `GET /v1/watches` | List watches. |
| `GET /v1/watches/:id` | Watch detail and current state. |
| `DELETE /v1/watches/:id` | Delete. |
| `POST /v1/watches/:id/check` | Force a check. Refused if the resource was checked within `MIN_CHECK_INTERVAL_SECONDS`, and for search watches (`NOT_SUPPORTED`). |
| `GET /v1/changes` | `?watch_id=&since=&limit=&peek=`. Returns `{ changes, cursor, has_more }`. |
| `POST /v1/changes/ack` | `{ "cursor", "watch_id"? }`. Acknowledges changes read with `peek=true`. |

Also served: `/` (homepage/docs), `/llms.txt`, `/.well-known/watchtower.json`, `/health`, and `/metrics` (Prometheus; set `METRICS_TOKEN` to require a bearer token).

Errors look like `{ "error": "WATCH_LIMIT", "message": "…" }`.

- **Can't be monitored (422):** `NO_JOB_DATA` (no supported platform and no `JobPosting` markup), `ROBOTS_DISALLOWED`, `BOT_CHALLENGE`, `ACCESS_DENIED`, `SSRF_BLOCKED`, `UNSUPPORTED_CONTENT_TYPE`, `BODY_TOO_LARGE`.
- **Capacity:** `WATCH_LIMIT` and `HOST_WATCH_LIMIT` (409), `HOST_CAPACITY` (429), `CAPACITY` (503).
- **Transient failures** (timeouts, 5xx, 404) keep the watch. They show up in `resource.last_error` and are retried with exponential backoff.

### Delivery options

- **Polling.** `get_changes` returns what's new and advances the cursor. For at-least-once processing, call `get_changes(peek=true)`, process the changes, then `ack_changes(cursor)`. If you crash before the ack, the same changes come back.
- **Webhooks.** Pass `webhook_url` when creating a watch. The creation response includes a `webhook_secret`, shown once. Each batch of matching changes is POSTed as JSON with these headers:
  - `x-watchtower-timestamp`
  - `x-watchtower-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`
  - `x-watchtower-delivery`

  Deliveries come from an outbox and are retried with exponential backoff (8 attempts). Webhook URLs go through the same SSRF checks as monitored URLs, and redirects are not followed.

### Watch lifecycle

A watch stays alive as long as someone uses it: `get_changes`, `get_watch`, `list_watches` or a successful webhook delivery renews it. Watches nobody touches for `WATCH_TTL_DAYS` (30) expire and stop costing fetches; `expires_at` is shown on every watch.

## How it works

```
 watches (per client) ──many-to-one──▶ resources (fetch url + adapter)
                                            │  scheduler: due? one per host, host lease held
                                            ▼
                     fetch ─▶ job-board API adapter, or JobPosting JSON-LD
                                            │  diff the job set vs the previous snapshot
                                            ▼
                     snapshot + typed job events, one transaction
                                            │  read through each watch's keyword filter
                                            ▼
                      get_changes (per-watch cursor)   ·   webhook outbox → signed POST
```

A search watch has no resource of its own. It reads the same change events, from every monitored resource, through its filters.

- **The board directory.** Boards in the directory are ordinary resources flagged `indexed`. The scheduler checks them every `INDEX_CHECK_INTERVAL_SECONDS` (default four hours) whether or not anyone watches them, and the listed part of the directory is synced from `src/search/boards.ts` and `INDEX_BOARDS_FILE` at startup. One request per platform host is in flight at a time, so a platform's boards are checked one after another: with the default 5 s scheduler tick that is about 700 boards per platform per hour, or 2,900 per four-hour cycle. A directory larger than that is not an error; boards are checked as fast as politeness allows, and `watchtower_directory_overdue_boards` shows how far behind it is. A board with a watch on it is still checked at that watch's interval.
- **Listing requests carry the posting text.** Greenhouse (`content=true`), Lever, Ashby (`includeCompensation=true`), Workable (`details=true`) and Recruitee return each posting's description and pay in the listing response, so salary and experience cost no extra requests. Only the derived fields are stored, never the description. These responses are large, so platform APIs get their own body cap (`MAX_API_BODY_BYTES`, 64 MB); a board larger than that is read as a plain listing, without pay or experience.

- **Board URLs map to platform endpoints.** `boards.greenhouse.io/acme`, `jobs.lever.co/acme`, `jobs.ashbyhq.com/acme`, `apply.workable.com/acme`, `jobs.smartrecruiters.com/Acme` and `acme.recruitee.com` (plus their EU and embed variants) are fetched from each platform's public job-board API in one request. Other URLs are fetched as HTML and read through schema.org `JobPosting` JSON-LD (including `@graph` and `ItemList`). Only the job list is compared, so page churn around it (session tokens, "rendered N minutes ago", banners) never registers as a change.
  - **Workday** (`acme.wd5.myworkdayjobs.com/Careers`, `wd3.myworkdaysite.com/recruiting/acme/External`): the site's own search endpoint, a JSON POST that returns postings newest first, 20 per page. A check reads the newest 200 (10 requests). Boards with more postings are marked `complete: false` on the snapshot and never emit `JOB_REMOVED`, because a job leaving the window isn't a removal. Job links point at the public site; the relative "Posted 3 Days Ago" is not kept.
  - **iCIMS** (`careers-acme.icims.com`): the portal's `sitemap.xml` lists every open job in one request (id plus a slug of the title), and the first page of `/jobs/search` gives the newest ~50 their real title, location and posting date. A check reads both. Jobs seen only in the sitemap are `partial: true` (title from the slug, no location); details learned earlier are carried forward, and a partial entry becoming a full one is not reported as an update.
- **Derived fields.** Every job gets `remote` (title or location says remote, and not hybrid/on-site) and `seniority` (intern, entry, mid, senior, staff, principal, manager, director, from the title; management words win over IC levels, and "mid" means the title carries no level). These are heuristics over the text, which is why they are exposed on the job rather than hidden inside the filter.
- **Resources vs. watches.** Watches are per-client intents. Resources are what actually gets fetched. Any number of watches on the same board (across clients) share one resource, one fetch per interval, and one set of snapshots. URLs are canonicalized before sharing: tracking parameters (`utm_*`, `fbclid`, `gclid`, …) are dropped and the query is sorted. The resource is checked at the shortest interval any of its active watches asks for, but never more often than `MIN_CHECK_INTERVAL_SECONDS` (default 5 minutes).
- **Job identity.** Jobs are keyed by the platform's job id, or for JSON-LD by `identifier`, then `url`, then title and location. A job whose title, location, department or url changed becomes `JOB_UPDATED` with `changed_fields`. A JSON-LD job without a stable id whose location changed is paired into one `JOB_UPDATED` instead of a remove plus an add.
- **Change events are written once per resource.** Each watch reads them through its filters, evaluated in SQL against the change's job data (and against the current job list, for `get_watch`): `keywords` (any, against title, location, department and company), `all_keywords` (every one), `exclude_keywords`, `locations` (against the job's location and `other_locations`), `seniority`, `remote_only`, `min_salary` and `max_experience_years`. Terms match whole words, case-insensitively and allowing a plural: "ios" matches "Senior iOS Engineer" but not "Game Studios", and "java" does not match "JavaScript". A watch never sees changes from before it was created. Change ids double as cursors, so change-writing transactions are serialized. That keeps ids visible in order, so a slow concurrent check can't commit an id that a reader has already moved past.
- **Politeness.** At most one fetch is in flight per website across all replicas, using a Postgres host lease with `HOST_MIN_SPACING_MS` between requests; a multi-request check (Workday, iCIMS) holds the lease for all of its requests and pauses briefly between them. Each scheduler tick claims at most one resource per host. Watchtower also:
  - sends `If-None-Match` / `If-Modified-Since` (a 304 means no work);
  - checks robots.txt (cached per origin for an hour, RFC 9309 semantics);
  - sends an identifying User-Agent;
  - backs off exponentially on errors and honors `Retry-After` on 429.
- **Scheduling and maintenance.** Due resources are claimed with a lease, so you can run several replicas; set `RUN_SCHEDULER=false` on API-only replicas. The same loop delivers webhooks and runs maintenance under an advisory lock. Maintenance:
  - expires unread watches;
  - deletes changes after `CHANGE_RETENTION_DAYS` and non-current snapshots after `SNAPSHOT_RETENTION_DAYS`;
  - removes unwatched resources and idle clients;
  - clears old rate-limit windows.

## Safety and abuse controls

- **SSRF.**
  - Only http/https on ports 80/443. URLs with credentials are rejected.
  - `localhost`, `*.local`, `*.internal`, single-label and numeric hosts are rejected.
  - Every resolved address must be globally routable unicast. Private, loopback, link-local (including cloud metadata), CGNAT, multicast, reserved, documentation, IPv4-mapped IPv6, 6to4, Teredo and NAT64 are all refused.
  - The check runs inside the socket's DNS lookup, so it holds at connect time for every redirect hop (defeating DNS rebinding) as well as once at watch creation.
  - Webhook URLs get the same treatment.
- **Request limits.** A 15 s overall deadline across all hops. At most 5 redirects, each re-validated. A 3 MB body cap (64 MB for job-board platform APIs) enforced on the decompressed bytes, so gzip and brotli bombs are caught. Text-like content types only.
- **API limits.** Rate limits are stored in Postgres, so they hold across replicas and restarts: 120 requests/min, 10 client creations/hour (shared with MCP auto-provisioning), and 10 forced checks/min. Clients are identified by IPv4 address or IPv6 /64.
- **Watch and resource caps.**
  - 50 watches per client, and 5 per client per website for arbitrary careers pages (platform boards are separate companies behind one API host and are exempt).
  - At most `MAX_RESOURCES_PER_HOST` distinct careers-page URLs per website across all clients; job-board platform APIs are exempt, and watching an already-monitored board is always allowed.
  - A global `MAX_ACTIVE_RESOURCES`.
- **Tokens.** Random 192-bit values; only their SHA-256 is stored. Request bodies are capped at 64 KB.
- **No bypassing.** Watchtower never works around CAPTCHAs, bot challenges, logins, paywalls or robots.txt. It detects them, tells the caller, logs `host is refusing us`, and counts them in `watchtower_blocked_resources_1h`.

## Operations

`GET /metrics` exposes Prometheus metrics:
- check outcomes by error code;
- fetch-duration histogram;
- changes emitted by type;
- webhook results;
- host-busy deferrals;
- gauges for active watches/resources, search watches, directory boards and how many are overdue, failing and blocked resources, and pending webhooks.

[`ops/alerts.yml`](ops/alerts.yml) has example alert rules: sites refusing us, high error rate, checks stalled, webhook backlog, slow fetches, and the directory falling behind its check interval.

## Configuration

See [.env.example](.env.example). The most important settings:
- `DATABASE_URL` and `PUBLIC_BASE_URL`.
- `MIN_CHECK_INTERVAL_SECONDS` and `HOST_MIN_SPACING_MS`.
- `INDEX_ENABLED`, `INDEX_CHECK_INTERVAL_SECONDS`, `INDEX_BOARDS_FILE` and `INDEX_MAX_PROMOTED`: the board directory that search watches are matched against. With `INDEX_ENABLED=false` Watchtower fetches only boards someone watches by URL.
- The caps: `MAX_WATCHES_PER_CLIENT`, `MAX_RESOURCES_PER_HOST` and `MAX_ACTIVE_RESOURCES`.
- `WATCH_TTL_DAYS` and the retention settings.
- `TRUST_PROXY`: set it behind a load balancer so rate limits see real client IPs.
- `ALLOW_PRIVATE_NETWORKS` turns SSRF protection off and exists only for tests and the demo.

## Development

```bash
npm run typecheck
npm test                                  # unit tests; integration tests need a database:
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/watchtower_test npm test
```

The integration suite drops and recreates the `public` schema of `TEST_DATABASE_URL`, so point it at a throwaway database.

The suite has three parts:
- Unit tests.
- Property-based fuzz tests (fast-check) over the HTML, JSON-LD and robots parsers and the job diff invariants.
- Source tests for the Workday and iCIMS parsers and pagination, and the remote/seniority classifier.
- Search tests for the query reader, the pay and experience parsers, whole-word matching, the filters and board discovery.
- Integration tests covering REST, MCP, sharing, filters, search watches and the board directory, batch creation, page churn, `NO_JOB_DATA`, host leases, concurrent checks, caps, expiry and retention, webhooks, rate limits and metrics.

CI (`.github/workflows/ci.yml`) runs typecheck, all tests against a Postgres service, the build and the demo. It also builds the Docker image and smoke-tests it: migrations, `/health`, `/metrics`, the homepage, and the non-root user.

```
src/
  server.ts, app.ts         entrypoint; Fastify app (site, REST, MCP)
  config.ts, db.ts          env config; pg pool + migration runner
  security/ssrf.ts          URL validation + connect-time DNS guard
  fetch/                    safeFetch (redirects, limits, decompression), robots.txt
  extract/                  job-board adapters (incl. Workday, iCIMS), JobPosting JSON-LD, remote/seniority
                            classifier, pay/experience parsing, term matching, job diff (identity, pairing)
  search/                   plain-language query reader; the built-in board directory; board discovery
                            (careers-page links, name guesses)
  services/                 clients, watches (board and search), checker, scheduler (+ maintenance), board
                            directory sync, host leases, rate limits, webhooks, metrics
  mcp/server.ts             MCP tools
  web/site.ts               homepage, llms.txt, well-known metadata
migrations/                 SQL migrations
ops/alerts.yml              example Prometheus alert rules
scripts/demo.ts             end-to-end demo
scripts/discover-boards.ts  grow the directory from a list of companies
```

## Deliberately out of scope

- Covering every job board on the internet, or employers outside tech. A search watch sees the directory and the boards people have watched. Discovery is an operator step from a company list, not a crawler, and aggregators such as LinkedIn or Indeed are not read.
- Filtering to technical roles. "Tech jobs" means jobs at tech companies; a sales role at one is reported if the filters match it.
- Reading each SmartRecruiters, Workday or iCIMS job page for its description, so those jobs carry no pay or experience.
- A maximum-salary filter, currency conversion, and understanding a query with a language model.
- Billing, accounts and dashboards.
- JavaScript rendering. Careers pages that aren't on a supported platform are only readable if their server-rendered HTML carries `JobPosting` JSON-LD.
- General page, feed or event monitoring. Watchtower used to do these; it now does job boards only (migration `003_jobs_only.sql` retires existing page and event watches).
- Pagination beyond the first 100 SmartRecruiters postings or the newest 200 Workday postings per board.
- Reading each iCIMS job page for details; only the newest ~50 jobs per portal get a real title and location.
