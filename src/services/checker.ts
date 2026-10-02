/**
 * Check one resource: take the host's politeness lease, fetch, extract the
 * job list, diff it against the previous snapshot, and persist the new
 * snapshot and change events atomically.
 */
import { collect, primaryRequestBody, primaryRequestUrl, requestsPerCheck } from '../extract/adapters.js';
import { computeChanges, contentHash } from '../extract/diff.js';
import { PLATFORM_ADAPTERS, type AdapterName, type Extraction, type JobItem } from '../extract/types.js';
import { robotsAllows } from '../fetch/robots.js';
import { FetchError, safeFetch, type FetchResult } from '../fetch/safeFetch.js';
import { fetchOptions, type Ctx } from './context.js';
import { acquireHostWaiting, releaseHost, tryAcquireHost } from './hostLease.js';
import { metrics } from './metrics.js';
import { enqueueWebhooks } from './webhooks.js';

export interface ResourceRow {
  id: string;
  url: string;
  host: string;
  selector: string;
  adapter: AdapterName;
  etag: string | null;
  last_modified: string | null;
  current_snapshot_id: string | null;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
  last_status: number | null;
  last_error: string | null;
  consecutive_failures: number;
  next_check_at: Date;
}

export type CheckOutcome =
  | { ok: true; changed: boolean; changes: number; notModified: boolean; firstSnapshot: boolean; jobs: number | null }
  | { ok: false; errorCode: string; error: string; permanent: boolean };

/** Errors that mean "we may not / cannot monitor this", as opposed to transient failures. */
export const PERMANENT_ERRORS = new Set(['ROBOTS_DISALLOWED', 'ACCESS_DENIED', 'BOT_CHALLENGE', 'SSRF_BLOCKED', 'UNSUPPORTED_CONTENT_TYPE', 'BODY_TOO_LARGE']);

const DAY = 86_400;

// Challenge pages from common bot-management vendors. We never try to get past
// these; we report them and back off.
const CHALLENGE_MARKERS = /(cf-challenge|challenge-platform|cf_chl_|captcha|recaptcha|hcaptcha|px-captcha|perimeterx|datadome|distil_r_captcha|are you a robot|verify you are human|access denied)/i;

class CheckFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export interface CheckOptions {
  /** Wait (briefly) for the host lease instead of deferring. Used by synchronous API paths. */
  waitForHost?: boolean;
}

const inFlight = new Map<string, Promise<CheckOutcome>>();

/** Pause between follow-up requests to one source within a check (pagination); briefer than the between-check spacing. */
const pageSpacingMs = (ctx: Ctx) => Math.min(ctx.config.hostMinSpacingMs, 750);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deduplicates concurrent checks of the same resource within this process. */
export function checkResource(ctx: Ctx, resourceId: string, opts: CheckOptions = {}): Promise<CheckOutcome> {
  let p = inFlight.get(resourceId);
  if (!p) {
    p = runCheck(ctx, resourceId, opts).finally(() => inFlight.delete(resourceId));
    inFlight.set(resourceId, p);
  }
  return p;
}

async function effectiveInterval(ctx: Ctx, resourceId: string): Promise<number> {
  const { rows } = await ctx.db.query<{ s: number | null; indexed: boolean | null }>(
    `SELECT (SELECT min(interval_seconds) FROM watches WHERE resource_id = $1 AND deleted_at IS NULL) AS s,
            (SELECT indexed FROM resources WHERE id = $1) AS indexed`,
    [resourceId],
  );
  // A directory board is checked at the directory's pace unless a watch asks for something faster.
  const wanted = [rows[0]?.s, rows[0]?.indexed ? ctx.config.indexCheckIntervalSeconds : null].filter((n): n is number => typeof n === 'number');
  return Math.max(wanted.length ? Math.min(...wanted) : ctx.config.defaultCheckIntervalSeconds, ctx.config.minCheckIntervalSeconds);
}

function parseRetryAfter(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : undefined;
}

async function runCheck(ctx: Ctx, resourceId: string, opts: CheckOptions): Promise<CheckOutcome> {
  const { rows } = await ctx.db.query<ResourceRow>('SELECT * FROM resources WHERE id = $1', [resourceId]);
  const r = rows[0];
  if (!r) return { ok: false, errorCode: 'NOT_FOUND', error: 'resource not found', permanent: true };

  // robots.txt + every request of the check, each bounded by the fetch timeout.
  const requests = requestsPerCheck(r.adapter);
  const leaseMs = ctx.config.fetchTimeoutMs * (requests + 1) + pageSpacingMs(ctx) * requests + ctx.config.hostMinSpacingMs + 5000;
  const acquired = opts.waitForHost
    ? await acquireHostWaiting(ctx.db, r.host, leaseMs, Math.min(10_000, ctx.config.fetchTimeoutMs))
    : await tryAcquireHost(ctx.db, r.host, leaseMs);
  if (!acquired) {
    metrics.hostBusy.inc();
    await ctx.db.query(`UPDATE resources SET next_check_at = now() + make_interval(secs => $2) WHERE id = $1`, [
      r.id,
      ctx.config.hostMinSpacingMs / 1000 + 1 + Math.random() * 5,
    ]);
    return { ok: false, errorCode: 'HOST_BUSY', error: `another fetch to ${r.host} is in progress; retrying shortly`, permanent: false };
  }
  const started = Date.now();
  try {
    return await checkWithLease(ctx, r);
  } finally {
    metrics.fetchSeconds.observe((Date.now() - started) / 1000);
    await releaseHost(ctx.db, r.host, ctx.config.hostMinSpacingMs).catch((err) => ctx.log.error({ err }, 'failed to release host lease'));
  }
}

/** Throws a CheckFailure for responses we must not (or cannot) monitor. */
function assertUsable(res: FetchResult): void {
  if (res.status === 429) {
    throw new CheckFailure('RATE_LIMITED', 'the site asked us to slow down (HTTP 429)', parseRetryAfter(res.headers['retry-after']));
  }
  if (res.status >= 400) {
    if ([401, 403, 429, 503].includes(res.status) && CHALLENGE_MARKERS.test(res.body.slice(0, 50_000))) {
      throw new CheckFailure('BOT_CHALLENGE', `HTTP ${res.status}: the site presented a bot check/CAPTCHA; Watchtower does not bypass these`);
    }
    if (res.status === 401 || res.status === 403 || res.status === 402) {
      throw new CheckFailure('ACCESS_DENIED', `HTTP ${res.status}: the resource requires authentication or payment; Watchtower only monitors public resources`);
    }
    throw new CheckFailure(`HTTP_${res.status}`, `HTTP ${res.status} from ${new URL(res.finalUrl).host}`);
  }
}

async function extractOrFail(ctx: Ctx, r: ResourceRow, res: FetchResult, opts: ReturnType<typeof fetchOptions>): Promise<Extraction> {
  const more = async (url: string, jsonBody?: string) => {
    await sleep(pageSpacingMs(ctx));
    if (!(await robotsAllows(url, opts))) throw new CheckFailure('ROBOTS_DISALLOWED', `robots.txt disallows fetching ${url}`);
    const page = await safeFetch(url, { ...opts, jsonBody });
    assertUsable(page);
    return page.body;
  };
  try {
    return await collect(r.adapter, r.url, res, more);
  } catch (err) {
    if (err instanceof CheckFailure || err instanceof FetchError) throw err;
    throw new CheckFailure('PARSE_ERROR', `could not parse response: ${(err as Error).message}`);
  }
}

/** Keep details learned earlier for jobs the source now lists only partially (iCIMS sitemap-only entries). */
function carryForward(current: Extraction, previous: JobItem[]): Extraction {
  const known = new Map(previous.filter((j) => !j.partial).map((j) => [j.key, j]));
  return { ...current, jobs: current.jobs.map((j) => (j.partial && known.has(j.key) ? known.get(j.key)! : j)) };
}

async function checkWithLease(ctx: Ctx, r: ResourceRow): Promise<CheckOutcome> {
  const interval = await effectiveInterval(ctx, r.id);
  // Listing APIs return every posting with its text in one response, which is far larger than a careers page.
  const opts = { ...fetchOptions(ctx.config), ...(PLATFORM_ADAPTERS.has(r.adapter) ? { maxBytes: Math.max(ctx.config.maxBodyBytes, ctx.config.maxApiBodyBytes) } : {}) };
  const requestUrl = primaryRequestUrl(r.adapter, r.url);

  try {
    if (!(await robotsAllows(requestUrl, opts))) {
      throw new CheckFailure('ROBOTS_DISALLOWED', 'robots.txt disallows fetching this URL; Watchtower respects robots.txt');
    }

    const conditional: Record<string, string> = {};
    if (r.current_snapshot_id) {
      if (r.etag) conditional['if-none-match'] = r.etag;
      if (r.last_modified) conditional['if-modified-since'] = r.last_modified;
    }
    const request = { ...opts, headers: conditional, jsonBody: primaryRequestBody(r.adapter) };
    const res = await safeFetch(requestUrl, request).catch((err) => {
      // A board too large to read with every posting's text is still read as a plain listing (no pay or experience).
      if (err instanceof FetchError && err.code === 'BODY_TOO_LARGE' && requestUrl !== r.url) return safeFetch(r.url, request);
      throw err;
    });

    const markHealthy = async (status: number, extraSql = '', extraParams: unknown[] = []) => {
      await ctx.db.query(
        `UPDATE resources SET last_checked_at = now(), last_status = $2, etag = COALESCE($3, etag), last_modified = COALESCE($4, last_modified),
           last_error = NULL, consecutive_failures = 0, next_check_at = now() + make_interval(secs => $5) ${extraSql}
         WHERE id = $1`,
        [r.id, status, res.headers.etag ?? null, res.headers['last-modified'] ?? null, interval, ...extraParams],
      );
    };

    if (res.notModified) {
      await markHealthy(304);
      metrics.checks.inc({ outcome: 'not_modified' });
      return { ok: true, changed: false, changes: 0, notModified: true, firstSnapshot: false, jobs: null };
    }
    assertUsable(res);

    const prevRow = r.current_snapshot_id
      ? (
          await ctx.db.query<{ id: string; content_hash: string; structured: { jobs?: JobItem[] } }>(
            'SELECT id, content_hash, structured FROM snapshots WHERE id = $1',
            [r.current_snapshot_id],
          )
        ).rows[0]
      : undefined;
    const current = carryForward(await extractOrFail(ctx, r, res, opts), prevRow?.structured.jobs ?? []);
    const hash = contentHash(current);

    if (prevRow && prevRow.content_hash === hash) {
      await markHealthy(res.status);
      metrics.checks.inc({ outcome: 'unchanged' });
      return { ok: true, changed: false, changes: 0, notModified: false, firstSnapshot: false, jobs: current.jobs.length };
    }

    const before: Extraction | null = prevRow ? { jobs: prevRow.structured.jobs ?? [] } : null;
    const changes = computeChanges(before, current);

    const client = await ctx.db.connect();
    let changeIds: number[] = [];
    try {
      await client.query('BEGIN');
      // Change ids double as delivery cursors, so they must become visible in id order:
      // a lower id committing after a reader already advanced past it would never be
      // delivered. Serializing these (short, I/O-free) transactions guarantees that.
      await client.query('SELECT pg_advisory_xact_lock(727276)');
      // Row lock + snapshot check: if someone else wrote a snapshot meanwhile, our diff is stale; drop it.
      const locked = await client.query<{ current_snapshot_id: string | null }>('SELECT current_snapshot_id FROM resources WHERE id = $1 FOR UPDATE', [r.id]);
      if ((locked.rows[0]?.current_snapshot_id ?? null) !== (prevRow?.id ?? null)) {
        await client.query('ROLLBACK');
        metrics.checks.inc({ outcome: 'raced' });
        return { ok: true, changed: false, changes: 0, notModified: false, firstSnapshot: false, jobs: current.jobs.length };
      }
      const snap = await client.query<{ id: string }>(
        `INSERT INTO snapshots (resource_id, status_code, content_type, content_hash, structured)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [r.id, res.status, res.contentType || null, hash, JSON.stringify({ jobs: current.jobs, complete: current.complete !== false })],
      );
      const snapshotId = snap.rows[0]!.id;
      for (const c of changes) {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO changes (resource_id, snapshot_id, type, item_key, summary, data, search_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [r.id, snapshotId, c.type, c.item_key, c.summary, JSON.stringify(c.data), c.search_text],
        );
        changeIds.push(ins.rows[0]!.id);
      }
      await client.query(
        `UPDATE resources SET last_checked_at = now(), last_status = $2, etag = $3, last_modified = $4, last_error = NULL,
           consecutive_failures = 0, next_check_at = now() + make_interval(secs => $5),
           current_snapshot_id = $6, last_changed_at = CASE WHEN $7 THEN now() ELSE last_changed_at END
         WHERE id = $1`,
        [r.id, res.status, res.headers.etag ?? null, res.headers['last-modified'] ?? null, interval, snapshotId, changeIds.length > 0],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      changeIds = [];
      throw err;
    } finally {
      client.release();
    }

    for (const c of changes) metrics.changes.inc({ type: c.type });
    // A new snapshot without changes means only untracked fields moved (e.g. posted_at).
    metrics.checks.inc({ outcome: changeIds.length ? 'changed' : prevRow ? 'unchanged' : 'first_snapshot' });
    if (changeIds.length) {
      ctx.log.info({ resource: r.id, url: r.url, changes: changeIds.length }, 'changes detected');
      await enqueueWebhooks(ctx, r.id, Math.min(...changeIds) - 1, Math.max(...changeIds)).catch((err) =>
        ctx.log.error({ err, resource: r.id }, 'failed to enqueue webhooks'),
      );
    }
    return { ok: true, changed: changeIds.length > 0, changes: changeIds.length, notModified: false, firstSnapshot: !prevRow, jobs: current.jobs.length };
  } catch (err) {
    const code = err instanceof CheckFailure || err instanceof FetchError ? err.code : 'INTERNAL_ERROR';
    const message = (err as Error).message;
    if (code === 'INTERNAL_ERROR') ctx.log.error({ err, resource: r.id }, 'check failed unexpectedly');
    else if (['BOT_CHALLENGE', 'ACCESS_DENIED', 'RATE_LIMITED'].includes(code)) ctx.log.warn({ host: r.host, code }, 'host is refusing us');
    metrics.checks.inc({ outcome: 'error', code });
    const permanent = PERMANENT_ERRORS.has(code);
    const failures = r.consecutive_failures + 1;
    // Exponential backoff on failure, capped at a day; permanent refusals wait a full day.
    let delay = permanent ? DAY : Math.min(interval * 2 ** Math.min(failures, 6), DAY);
    const retryAfter = err instanceof CheckFailure ? err.retryAfterSeconds : undefined;
    if (retryAfter !== undefined) delay = Math.min(Math.max(delay, retryAfter), 7 * DAY);
    const status = /^HTTP_(\d+)$/.exec(code)?.[1];
    await ctx.db.query(
      `UPDATE resources SET last_checked_at = now(), last_error = $2, consecutive_failures = $3,
         next_check_at = now() + make_interval(secs => $4), last_status = COALESCE($5, last_status) WHERE id = $1`,
      [r.id, `${code}: ${message}`, failures, delay, status ? Number(status) : null],
    );
    return { ok: false, errorCode: code, error: message, permanent };
  }
}
