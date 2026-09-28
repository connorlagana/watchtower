# Watchtower

**Stop repeatedly browsing the same pages. Watchtower monitors public internet resources for AI agents and returns structured changes.**

An agent creates a persistent watch once: "tell me when this page changes", "tell me when a new iOS job appears", "tell me when this event adds a date". Watchtower checks the resource on a schedule and remembers what it saw. `get_changes` then returns only what changed, as structured JSON, so the agent never has to re-read the page.

- **MCP** (Streamable HTTP) and **REST**, backed by the same service layer
- Free and anonymous: a client gets a token and up to 10 watches
- TypeScript, Node.js 22, Fastify 5, PostgreSQL, the official MCP TypeScript SDK
- No LLM required

## Quick start

```bash
cd watchtower
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
| `watch_url` | Watch a public page. Emits `CONTENT_CHANGED` with lines added/removed. Optional `keywords`, CSS `selector`. |
| `watch_jobs` | Watch a job board. Greenhouse and Lever use their public job-board APIs; other pages use schema.org `JobPosting`. Emits `JOB_ADDED` / `JOB_REMOVED` / `JOB_UPDATED`. Optional `keywords`. |
| `watch_events` | Watch an event page. Uses schema.org `Event` JSON-LD, falling back to dates found in the page text. Emits `EVENT_ADDED` / `EVENT_REMOVED` / `EVENT_UPDATED`. |
| `get_changes` | Changes since your last call (the cursor advances). `peek`, `since` (replay), `watch_id`, `limit`. |
| `list_watches` | Your watches, with health and pending-change counts. |
| `get_watch` | One watch plus the current state: matching jobs, events, or a text excerpt. |
| `delete_watch` | Stop monitoring and free a slot. |

The tool descriptions and server `instructions` tell agents to prefer Watchtower over re-browsing for recurring checks.

Auth: send `Authorization: Bearer <token>` on the MCP connection, or pass `client_token` as a tool argument. If a `watch_*` call arrives with no token, Watchtower creates an anonymous client and returns its token in the result, so an agent can start with zero setup.

## REST API

All endpoints except `POST /v1/clients` need `Authorization: Bearer <token>`.

| Method & path | |
|---|---|
| `POST /v1/clients` | Create an anonymous client. Returns `token` (shown once). Rate-limited per IP. |
| `POST /v1/watches` | `{ "type": "url"\|"jobs"\|"events", "url", "keywords"?, "selector"?, "interval_minutes"?, "label"? }` |
| `GET /v1/watches` | List watches. |
| `GET /v1/watches/:id` | Watch detail and current state. |
| `DELETE /v1/watches/:id` | Delete. |
| `POST /v1/watches/:id/check` | Force a check. Refused if the resource was checked within `MIN_CHECK_INTERVAL_SECONDS`. |
| `GET /v1/changes` | `?watch_id=&since=&limit=&peek=`. Returns `{ changes, cursor, has_more }`. |

Also served: `/` (homepage/docs), `/llms.txt`, `/.well-known/watchtower.json`, `/health`.

Errors look like `{ "error": "WATCH_LIMIT", "message": "…" }`. Creating a watch fails with 422 and a specific code when the resource can't be monitored legitimately: `ROBOTS_DISALLOWED`, `BOT_CHALLENGE`, `ACCESS_DENIED`, `SSRF_BLOCKED`, `UNSUPPORTED_CONTENT_TYPE`, or `BODY_TOO_LARGE`. Transient failures (timeouts, 5xx, 404) keep the watch; they show up in `resource.last_error` and are retried with exponential backoff.

## How it works

```
 watches (per client) ──many-to-one──▶ resources (url + selector + adapter)
                                            │  scheduler: due? fetch once
                                            ▼
                            snapshots (only when the content hash changes)
                                            │  diff vs previous snapshot
                                            ▼
                              changes (resource-level, typed, bigserial id)
                                            │  read through each watch's type + keyword filter
                                            ▼
                               get_changes (per-watch cursor)
```

- **Resources vs. watches.** Watches are per-client intents. Resources are what actually gets fetched. Any number of watches on the same URL (across clients) share one resource, one fetch per interval, and one set of snapshots. The resource is checked at the shortest interval any of its active watches asks for, but never more often than `MIN_CHECK_INTERVAL_SECONDS` (default 5 minutes).
- **Change events are written once per resource.** Each watch reads them through its own filter: `change_types` comes from the watch kind, and `keywords` does a case-insensitive match against the change's search text. A watch never sees changes from before it was created.
- **Fetching politely.** Watchtower sends `If-None-Match` / `If-Modified-Since` (a 304 means no work), checks robots.txt (cached per origin for an hour, RFC 9309 semantics), sends an identifying User-Agent, backs off exponentially on errors, and honors `Retry-After` on 429.
- **Normalization.** HTML is reduced to visible, line-oriented text: scripts, styles, comments, hidden inputs, `[hidden]` and `aria-hidden` elements are removed, and whitespace is collapsed. Volatile tokens (40+ character ids, "N minutes ago") are masked. Line diffs are multiset-based, so pure reordering isn't reported as a change.
- **Structured extraction.** JSON-LD `JobPosting` and `Event` nodes (including subtypes, `@graph`, `ItemList`, `subEvent`) plus the Greenhouse and Lever adapters produce keyed items. Events are keyed by name/url + start date, so a new date shows up as `EVENT_ADDED`.
- **Scheduling.** Due resources are claimed with `FOR UPDATE SKIP LOCKED` plus a lease, so you can run several replicas. Set `RUN_SCHEDULER=false` on API-only replicas.

## Safety

- **SSRF.** Only http/https on ports 80/443. URLs with credentials are rejected. `localhost`, `*.local`, `*.internal`, single-label and numeric hosts are rejected. Every resolved address must be globally routable unicast: private, loopback, link-local (including cloud metadata), CGNAT, multicast, reserved, documentation, IPv4-mapped IPv6, 6to4, Teredo and NAT64 are all refused. The check runs inside the socket's DNS lookup, so it holds at connect time for every redirect hop (defeating DNS rebinding) as well as once at watch creation.
- **Request limits.** A 15 s overall deadline across all hops. At most 5 redirects, each re-validated. A 3 MB body cap enforced on the decompressed bytes, so gzip and brotli bombs are caught. Text-like content types only.
- **API limits.** Per-IP rate limits (120/min overall, 10 client creations/hour), a 64 KB request body cap, and 10 watches per client, enforced under a row lock. Tokens are random 192-bit values; only their SHA-256 is stored.
- **No bypassing.** Watchtower never works around CAPTCHAs, bot challenges, logins, paywalls or robots.txt. It detects them and tells the caller.

## Configuration

See [.env.example](.env.example). The most important settings are `DATABASE_URL`, `PUBLIC_BASE_URL`, `MIN_CHECK_INTERVAL_SECONDS`, `MAX_WATCHES_PER_CLIENT` and `TRUST_PROXY` (set it behind a load balancer so rate limits see real IPs). `ALLOW_PRIVATE_NETWORKS` turns SSRF protection off and exists only for tests and the demo.

## Development

```bash
npm run typecheck
npm test                                  # unit tests; integration tests need a database:
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/watchtower_test npm test
```

The integration suite drops and recreates the `public` schema of `TEST_DATABASE_URL`, so point it at a throwaway database. CI (`.github/workflows/watchtower.yml`) runs typecheck, all tests against a Postgres service, the build, the demo, and a Docker build.

```
src/
  server.ts, app.ts         entrypoint; Fastify app (site, REST, MCP)
  config.ts, db.ts          env config; pg pool + migration runner
  security/ssrf.ts          URL validation + connect-time DNS guard
  fetch/                    safeFetch (redirects, limits, decompression), robots.txt
  extract/                  HTML normalization, JSON-LD, date fallback, Greenhouse/Lever adapters, diff
  services/                 clients, watches, checker, scheduler
  mcp/server.ts             MCP tools
  web/site.ts               homepage, llms.txt, well-known metadata
migrations/                 SQL migrations
scripts/demo.ts             end-to-end demo
```

## Deliberately out of scope for v1

- Billing, accounts, dashboards, webhooks and push notifications. Agents poll `get_changes`.
- LLM-based semantic summaries. The hook point would be change creation in `services/checker.ts`, and the product works without one.
- JavaScript rendering. Watchtower only sees server-rendered HTML and JSON, so pages that build their content client-side show little text. Their JSON-LD often still works.
- RSS/Atom-specific parsing (feeds are diffed as text), per-host politeness queues, and snapshot/change retention pruning.
