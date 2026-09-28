# Watchtower

**Stop repeatedly browsing the same pages. Watchtower monitors public internet resources for AI agents and returns structured changes.**

An agent creates a persistent watch once: "tell me when this page changes", "tell me when a new iOS job appears", "tell me when this event adds a date". Watchtower checks the resource on a schedule and remembers what it saw. `get_changes` then returns only what changed, as structured JSON, so the agent never has to re-read the page.

- **MCP** (Streamable HTTP) and **REST**, backed by the same service layer
- Free and anonymous: a client gets a token and up to 10 watches
- TypeScript, Node.js 22, Fastify 5, PostgreSQL, the official MCP TypeScript SDK
- No LLM or third-party API keys required

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

`npm run demo` (with `DATABASE_URL` set) runs the core loop end to end against a local fixture "careers page":

1. create client → 2. create a job watch with keyword `ios` (takes the initial snapshot) → 3. a second watch on the same URL reuses the same resource → 4. a re-check where only volatile noise changed (session token, "N minutes ago") reports no change → 5. the source adds an iOS job and an Android job → 6. Watchtower checks and detects the change → 7. an MCP client calls `get_changes`:

```json
{
  "changes": [
    { "type": "CONTENT_CHANGED", "watch_kind": "url",
      "summary": "Content changed: +2/-0 lines — \"Senior iOS Engineer — Remote - US\"",
      "data": { "added": ["Senior iOS Engineer — Remote - US", "Android Engineer — Berlin"], "removed": [] } },
    { "type": "JOB_ADDED", "watch_kind": "jobs",
      "summary": "New job: Senior iOS Engineer (Remote - US)",
      "data": { "job": { "title": "Senior iOS Engineer", "location": "Remote - US", "company": "Acme Robotics", "url": "…/careers/ios-303" } } }
  ],
  "cursor": 3, "has_more": false
}
```

The Android job is filtered out by the job watch's keyword. 8. A second `get_changes` call returns `[]`.

The demo runs its fixture on 127.0.0.1, so it turns on `ALLOW_PRIVATE_NETWORKS` for its own process only.

## Connecting an agent (MCP)

```json
{ "mcpServers": { "watchtower": { "type": "http", "url": "http://localhost:3000/mcp" } } }
```

| Tool | What it does |
|---|---|
| `watch_url` | Watch a public page or RSS/Atom feed. Pages emit `CONTENT_CHANGED` with added/removed lines, word-level diffs and context. Feeds emit `ITEM_ADDED` per new entry. Optional `keywords` and CSS `selector`. |
| `watch_jobs` | Watch a job board. Greenhouse, Lever, Ashby, Workable, SmartRecruiters and Recruitee use their public job-board APIs; other pages use schema.org `JobPosting`. Emits `JOB_ADDED` / `JOB_REMOVED` / `JOB_UPDATED`. Optional `keywords`. |
| `watch_events` | Watch an event page. Uses schema.org `Event` JSON-LD, falling back to future dates in the main page text. Emits `EVENT_ADDED` / `EVENT_REMOVED` / `EVENT_UPDATED` / `EVENT_RESCHEDULED`. |
| `get_changes` | Changes since your last call (the cursor advances). `peek`, `since` (replay), `watch_id`, `limit`. |
| `ack_changes` | Acknowledge a cursor after `get_changes(peek=true)`, for at-least-once processing. |
| `list_watches` | Your watches, with health, expiry and pending-change counts. |
| `get_watch` | One watch plus the current state: matching jobs, events, feed items, or a text excerpt. |
| `delete_watch` | Stop monitoring and free a slot. |

Every `watch_*` tool also accepts `webhook_url` for push delivery (see below).

The tool descriptions and server `instructions` tell agents to prefer Watchtower over re-browsing for recurring checks.

Auth: send `Authorization: Bearer <token>` on the MCP connection, or pass `client_token` as a tool argument. If a `watch_*` call arrives with no token, Watchtower creates an anonymous client and returns its token in the result, so an agent can start with zero setup. This draws on the same per-address budget as `POST /v1/clients`.

## REST API

All endpoints except `POST /v1/clients` need `Authorization: Bearer <token>`.

| Method & path | |
|---|---|
| `POST /v1/clients` | Create an anonymous client. Returns `token` (shown once). Rate-limited per address. |
| `POST /v1/watches` | `{ "type": "url"\|"jobs"\|"events", "url", "keywords"?, "selector"?, "interval_minutes"?, "label"?, "webhook_url"? }` |
| `GET /v1/watches` | List watches. |
| `GET /v1/watches/:id` | Watch detail and current state. |
| `DELETE /v1/watches/:id` | Delete. |
| `POST /v1/watches/:id/check` | Force a check. Refused if the resource was checked within `MIN_CHECK_INTERVAL_SECONDS`. |
| `GET /v1/changes` | `?watch_id=&since=&limit=&peek=`. Returns `{ changes, cursor, has_more }`. |
| `POST /v1/changes/ack` | `{ "cursor", "watch_id"? }`. Acknowledges changes read with `peek=true`. |

Also served: `/` (homepage/docs), `/llms.txt`, `/.well-known/watchtower.json`, `/health`, and `/metrics` (Prometheus; set `METRICS_TOKEN` to require a bearer token).

Errors look like `{ "error": "WATCH_LIMIT", "message": "…" }`.

- **Can't be monitored legitimately (422):** `ROBOTS_DISALLOWED`, `BOT_CHALLENGE`, `ACCESS_DENIED`, `SSRF_BLOCKED`, `UNSUPPORTED_CONTENT_TYPE`, `BODY_TOO_LARGE`.
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
 watches (per client) ──many-to-one──▶ resources (url + selector + adapter)
                                            │  scheduler: due? one per host, host lease held
                                            ▼
                     fetch ─▶ extract main content / JSON-LD / feed / job API
                                            │  diff vs previous snapshot, minus learned noise
                                            │  change? fetch again, keep only what both fetches agree on
                                            ▼
                     snapshot + typed change events, one transaction
                                            │  read through each watch's type / keyword filter
                                            ▼
                      get_changes (per-watch cursor)   ·   webhook outbox → signed POST
```

- **Resources vs. watches.** Watches are per-client intents. Resources are what actually gets fetched. Any number of watches on the same URL (across clients) share one resource, one fetch per interval, and one set of snapshots. URLs are canonicalized before sharing: tracking parameters (`utm_*`, `fbclid`, `gclid`, …) are dropped and the query is sorted. The resource is checked at the shortest interval any of its active watches asks for, but never more often than `MIN_CHECK_INTERVAL_SECONDS` (default 5 minutes).
- **Change events are written once per resource.** Each watch reads them through its own filter:
  - `change_types` comes from the watch kind.
  - `keywords` does a case-insensitive match against the change's search text.

  A watch never sees changes from before it was created. Change ids double as cursors, so change-writing transactions are serialized. That keeps ids visible in order, so a slow concurrent check can't commit an id that a reader has already moved past.
- **Politeness.** At most one fetch is in flight per website across all replicas, using a Postgres host lease with `HOST_MIN_SPACING_MS` between requests. Each scheduler tick claims at most one resource per host. Watchtower also:
  - sends `If-None-Match` / `If-Modified-Since` (a 304 means no work);
  - checks robots.txt (cached per origin for an hour, RFC 9309 semantics);
  - sends an identifying User-Agent;
  - backs off exponentially on errors and honors `Retry-After` on 429.
- **Noise suppression**, so `CONTENT_CHANGED` means something:
  1. **Main content only.** Scripts, styles, comments, hidden elements, navigation, page headers and footers, sidebars, dialogs and cookie/consent banners are dropped. `<main>` or `<article>` is preferred when it holds most of the text. A CSS `selector` overrides all of this.
  2. **Token masking.** 40+ character ids and "N minutes ago" are masked. Line diffs are multiset-based, so pure reordering is ignored.
  3. **Learned volatility.** Each line is reduced to a *signature* (its shape with numbers and calendar words masked). Per resource, Watchtower counts how often each signature changes relative to how many checks it has observed. Lines that change on at least half of all checks (view counters, clocks, rotating "trending" widgets) are suppressed and reported as `suppressed_noise_lines`. A price that changes weekly on an hourly watch changes on under 1% of checks and is always reported. Stats decay, so noise that stops changing stops being suppressed.
  4. **Confirmation fetch.** When a check finds a change on an HTML page, Watchtower fetches once more and keeps only what both fetches agree on. Lines that flip between the two loads are marked as noise immediately. This costs one extra request per real change, never per check.
- **Readable diffs.** `CONTENT_CHANGED.data.details` pairs similar removed and added lines into `modified` entries with a word-level diff (`Price: [-$10-]{+$12+}`) and neighbouring context lines.
- **Structured extraction.**
  - **JSON-LD:** `JobPosting` and `Event` nodes, including subtypes, `@graph`, `ItemList` and `subEvent`.
  - **Job-board APIs:** Greenhouse, Lever, Ashby, Workable, SmartRecruiters and Recruitee.
  - **Feeds:** RSS 2.0 and Atom.
  - **JSON:** arrays are keyed by `id`/`slug`/`url` when present, so inserting an element doesn't renumber the rest.
  - **Pairing:** a JSON-LD job whose location changed becomes `JOB_UPDATED`, and an event whose date moved becomes `EVENT_RESCHEDULED`, instead of a remove plus an add.
  - **Text-date fallback:** only counts dates at least two days out, so "today" in a page header isn't an event, and dates passing into the past aren't reported as removals.
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
- **Request limits.** A 15 s overall deadline across all hops. At most 5 redirects, each re-validated. A 3 MB body cap enforced on the decompressed bytes, so gzip and brotli bombs are caught. Text-like content types only.
- **API limits.** Rate limits are stored in Postgres, so they hold across replicas and restarts: 120 requests/min, 10 client creations/hour (shared with MCP auto-provisioning), and 10 forced checks/min. Clients are identified by IPv4 address or IPv6 /64.
- **Watch and resource caps.**
  - 10 watches per client, and 5 per client per website.
  - At most `MAX_RESOURCES_PER_HOST` distinct URLs per website across all clients; job-board platform APIs are exempt, and watching an already-monitored URL is always allowed.
  - A global `MAX_ACTIVE_RESOURCES`.
- **Tokens.** Random 192-bit values; only their SHA-256 is stored. Request bodies are capped at 64 KB.
- **No bypassing.** Watchtower never works around CAPTCHAs, bot challenges, logins, paywalls or robots.txt. It detects them, tells the caller, logs `host is refusing us`, and counts them in `watchtower_blocked_resources_1h`.

## Operations

`GET /metrics` exposes Prometheus metrics:
- check outcomes by error code;
- fetch-duration histogram;
- changes emitted by type;
- suppressed noise lines;
- webhook results;
- host-busy deferrals;
- gauges for active watches/resources, failing and blocked resources, and pending webhooks.

[`ops/alerts.yml`](ops/alerts.yml) has example alert rules: sites refusing us, high error rate, checks stalled, webhook backlog, and slow fetches.

## Configuration

See [.env.example](.env.example). The most important settings:
- `DATABASE_URL` and `PUBLIC_BASE_URL`.
- `MIN_CHECK_INTERVAL_SECONDS` and `HOST_MIN_SPACING_MS`.
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
- Property-based fuzz tests (fast-check) over the HTML, JSON-LD, feed, robots and date parsers and the diff invariants.
- Integration tests covering REST, MCP, sharing, noise suppression, host leases, concurrent checks, caps, expiry and retention, webhooks, rate limits and metrics.

CI (`.github/workflows/ci.yml`) runs typecheck, all tests against a Postgres service, the build and the demo. It also builds the Docker image and smoke-tests it: migrations, `/health`, `/metrics`, the homepage, and the non-root user.

```
src/
  server.ts, app.ts         entrypoint; Fastify app (site, REST, MCP)
  config.ts, db.ts          env config; pg pool + migration runner
  security/ssrf.ts          URL validation + connect-time DNS guard
  fetch/                    safeFetch (redirects, limits, decompression), robots.txt
  extract/                  main-content HTML normalization, JSON-LD, feeds, date fallback, job-board adapters,
                            volatility learning, diff (word diffs, pairing)
  services/                 clients, watches, checker, scheduler (+ maintenance), host leases, rate limits,
                            webhooks, metrics
  mcp/server.ts             MCP tools
  web/site.ts               homepage, llms.txt, well-known metadata
migrations/                 SQL migrations
ops/alerts.yml              example Prometheus alert rules
scripts/demo.ts             end-to-end demo
```

## Deliberately out of scope

- Billing, accounts and dashboards.
- JavaScript rendering. Watchtower only sees server-rendered HTML, JSON and feeds, so pages that build their content client-side show little text. Their JSON-LD often still works.
- Pagination beyond the first 100 SmartRecruiters postings per company.
