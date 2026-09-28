/**
 * Check one resource: take the host's politeness lease, fetch, extract, diff
 * against the previous snapshot with learned noise suppression, confirm real
 * changes with a second fetch, evaluate LLM conditions, and persist the new
 * snapshot, change events and verdicts atomically.
 */
import { extract } from '../extract/adapters.js';
import { computeChanges, diffLines, hashes, type ChangeDraft } from '../extract/diff.js';
import { API_ADAPTERS, type AdapterName, type Extraction } from '../extract/types.js';
import { isVolatile, lineSignature, normalizeStats, recordObservation, type LineStats } from '../extract/volatility.js';
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
  line_stats: unknown;
}

export type CheckOutcome =
  | { ok: true; changed: boolean; changes: number; notModified: boolean; firstSnapshot: boolean; suppressedLines: number }
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
  const { rows } = await ctx.db.query<{ s: number | null }>(
    'SELECT min(interval_seconds) AS s FROM watches WHERE resource_id = $1 AND deleted_at IS NULL',
    [resourceId],
  );
  return Math.max(rows[0]?.s ?? ctx.config.defaultCheckIntervalSeconds, ctx.config.minCheckIntervalSeconds);
}

function parseRetryAfter(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCheck(ctx: Ctx, resourceId: string, opts: CheckOptions): Promise<CheckOutcome> {
  const { rows } = await ctx.db.query<ResourceRow>('SELECT * FROM resources WHERE id = $1', [resourceId]);
  const r = rows[0];
  if (!r) return { ok: false, errorCode: 'NOT_FOUND', error: 'resource not found', permanent: true };

  // robots.txt + fetch + confirmation fetch, each bounded by the fetch timeout.
  const leaseMs = ctx.config.fetchTimeoutMs * 3 + ctx.config.hostMinSpacingMs + 5000;
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

function extractOrFail(r: ResourceRow, res: FetchResult): Extraction {
  try {
    return extract(r.adapter, res.body, res.contentType, { baseUrl: res.finalUrl, selector: r.selector || undefined });
  } catch (err) {
    throw new CheckFailure('PARSE_ERROR', `could not parse response: ${(err as Error).message}`);
  }
}

/** Keep only what two back-to-back fetches agree on. */
function stabilize(a: Extraction, b: Extraction): { stable: Extraction; flakyLines: string[] } {
  const { added, removed } = diffLines(a.text, b.text);
  const inB = new Map<string, number>();
  for (const l of b.text.split('\n')) inB.set(l, (inB.get(l) ?? 0) + 1);
  const keptLines: string[] = [];
  for (const l of a.text.split('\n')) {
    const n = inB.get(l) ?? 0;
    if (n > 0) {
      keptLines.push(l);
      inB.set(l, n - 1);
    }
  }
  const keys = <T extends { key: string }>(list: T[] = []) => new Set(list.map((i) => i.key));
  const [bj, be, bi] = [keys(b.jobs), keys(b.events), keys(b.items)];
  return {
    stable: {
      ...a,
      text: keptLines.join('\n'),
      jobs: a.jobs.filter((j) => bj.has(j.key)),
      events: a.events.filter((e) => be.has(e.key)),
      items: a.items?.filter((i) => bi.has(i.key)),
    },
    flakyLines: [...added, ...removed],
  };
}

function matchesKeywords(searchText: string, keywords: string[]): boolean {
  return keywords.length === 0 || keywords.some((k) => searchText.includes(k));
}

/** Evaluate LLM conditions for every conditional watch on this resource. Fail open: if evaluation fails, deliver. */
async function evaluateConditions(ctx: Ctx, resourceId: string, changes: ChangeDraft[]) {
  const verdicts: { watchId: string; index: number; match: boolean; reason: string }[] = [];
  const { rows: watches } = await ctx.db.query<{ id: string; condition: string; change_types: string[]; keywords: string[] }>(
    'SELECT id, condition, change_types, keywords FROM watches WHERE resource_id = $1 AND deleted_at IS NULL AND condition IS NOT NULL',
    [resourceId],
  );
  for (const w of watches) {
    const candidates = changes
      .map((c, index) => ({ c, index }))
      .filter(({ c }) => w.change_types.includes(c.type) && matchesKeywords(c.search_text, w.keywords));
    if (candidates.length === 0) continue;
    const result = ctx.conditions ? await ctx.conditions.evaluate(w.condition, candidates.map(({ c }) => c)) : null;
    candidates.forEach(({ index }, i) => {
      const v = result?.[i] ?? { match: true, reason: 'condition could not be evaluated; delivered unfiltered' };
      verdicts.push({ watchId: w.id, index, match: v.match, reason: v.reason });
    });
  }
  return verdicts;
}

async function checkWithLease(ctx: Ctx, r: ResourceRow): Promise<CheckOutcome> {
  const interval = await effectiveInterval(ctx, r.id);
  const opts = fetchOptions(ctx.config);
  let stats: LineStats = normalizeStats(r.line_stats);

  try {
    if (!(await robotsAllows(r.url, opts))) {
      throw new CheckFailure('ROBOTS_DISALLOWED', 'robots.txt disallows fetching this URL; Watchtower respects robots.txt');
    }

    const conditional: Record<string, string> = {};
    if (r.current_snapshot_id) {
      if (r.etag) conditional['if-none-match'] = r.etag;
      if (r.last_modified) conditional['if-modified-since'] = r.last_modified;
    }
    const res = await safeFetch(r.url, { ...opts, headers: conditional });

    const markHealthy = async (status: number, extraSql = '', extraParams: unknown[] = []) => {
      await ctx.db.query(
        `UPDATE resources SET last_checked_at = now(), last_status = $2, etag = COALESCE($3, etag), last_modified = COALESCE($4, last_modified),
           last_error = NULL, consecutive_failures = 0, next_check_at = now() + make_interval(secs => $5), line_stats = $6 ${extraSql}
         WHERE id = $1`,
        [r.id, status, res.headers.etag ?? null, res.headers['last-modified'] ?? null, interval, JSON.stringify(stats), ...extraParams],
      );
    };

    if (res.notModified) {
      stats = recordObservation(stats, []);
      await markHealthy(304);
      metrics.checks.inc({ outcome: 'not_modified' });
      return { ok: true, changed: false, changes: 0, notModified: true, firstSnapshot: false, suppressedLines: 0 };
    }
    assertUsable(res);

    const first = extractOrFail(r, res);
    const prevRow = r.current_snapshot_id
      ? (
          await ctx.db.query<{ id: string; content_hash: string; title: string | null; text: string; structured: Partial<Extraction> }>(
            'SELECT id, content_hash, title, text, structured FROM snapshots WHERE id = $1',
            [r.current_snapshot_id],
          )
        ).rows[0]
      : undefined;

    if (prevRow && prevRow.content_hash === hashes(first).contentHash) {
      stats = recordObservation(stats, []);
      await markHealthy(res.status);
      metrics.checks.inc({ outcome: 'unchanged' });
      return { ok: true, changed: false, changes: 0, notModified: false, firstSnapshot: false, suppressedLines: 0 };
    }

    const before: Extraction | null = prevRow
      ? {
          title: prevRow.title,
          text: prevRow.text,
          jobs: prevRow.structured.jobs ?? [],
          events: prevRow.structured.events ?? [],
          items: prevRow.structured.items,
          isFeed: prevRow.structured.isFeed,
        }
      : null;
    const now = new Date();
    let current = first;
    let diff = computeChanges(before, first, { isNoise: (l) => isVolatile(stats, l), now });
    let flakyLines: string[] = [];

    // A change on an HTML page might just be content that differs on every load (rotating
    // widgets, A/B tests). Fetch once more and keep only what both fetches agree on.
    if (before && diff.changes.length && ctx.config.confirmChanges && !API_ADAPTERS.has(r.adapter)) {
      await sleep(ctx.config.hostMinSpacingMs);
      try {
        const res2 = await safeFetch(r.url, opts);
        if (res2.status === 200) {
          const { stable, flakyLines: flaky } = stabilize(first, extractOrFail(r, res2));
          flakyLines = flaky;
          // Match by shape: last time's "Trending: #812" is the same noise as this time's "Trending: #377".
          const flakySigs = new Set(flaky.map(lineSignature));
          current = stable;
          diff = computeChanges(before, stable, { isNoise: (l) => flakySigs.has(lineSignature(l)) || isVolatile(stats, l), now });
        }
      } catch (err) {
        ctx.log.warn({ resource: r.id, err: (err as Error).message }, 'confirmation fetch failed; using first fetch');
      }
    }
    stats = recordObservation(stats, diff.changedLines, flakyLines);
    metrics.suppressed.inc({}, diff.suppressedLines);

    if (before && diff.changes.length === 0) {
      // Only noise changed. Keep the previous snapshot as the baseline.
      await markHealthy(res.status);
      metrics.checks.inc({ outcome: 'unchanged' });
      return { ok: true, changed: false, changes: 0, notModified: false, firstSnapshot: false, suppressedLines: diff.suppressedLines };
    }

    const verdicts = before ? await evaluateConditions(ctx, r.id, diff.changes) : [];
    const { textHash, contentHash } = hashes(current);
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
        return { ok: true, changed: false, changes: 0, notModified: false, firstSnapshot: false, suppressedLines: 0 };
      }
      const snap = await client.query<{ id: string }>(
        `INSERT INTO snapshots (resource_id, status_code, content_type, content_hash, text_hash, title, text, structured)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          r.id,
          res.status,
          res.contentType || null,
          contentHash,
          textHash,
          current.title,
          current.text,
          JSON.stringify({ jobs: current.jobs, events: current.events, items: current.items, isFeed: current.isFeed }),
        ],
      );
      const snapshotId = snap.rows[0]!.id;
      for (const c of diff.changes) {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO changes (resource_id, snapshot_id, type, item_key, summary, data, search_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [r.id, snapshotId, c.type, c.item_key, c.summary, JSON.stringify(c.data), c.search_text],
        );
        changeIds.push(ins.rows[0]!.id);
      }
      for (const v of verdicts) {
        await client.query('INSERT INTO watch_change_verdicts (watch_id, change_id, match, reason) VALUES ($1, $2, $3, $4)', [
          v.watchId,
          changeIds[v.index],
          v.match,
          v.reason.slice(0, 500),
        ]);
      }
      await client.query(
        `UPDATE resources SET last_checked_at = now(), last_status = $2, etag = $3, last_modified = $4, last_error = NULL,
           consecutive_failures = 0, next_check_at = now() + make_interval(secs => $5), line_stats = $6,
           current_snapshot_id = $7, last_changed_at = CASE WHEN $8 THEN now() ELSE last_changed_at END
         WHERE id = $1`,
        [r.id, res.status, res.headers.etag ?? null, res.headers['last-modified'] ?? null, interval, JSON.stringify(stats), snapshotId, changeIds.length > 0],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      changeIds = [];
      throw err;
    } finally {
      client.release();
    }

    for (const c of diff.changes) metrics.changes.inc({ type: c.type });
    metrics.checks.inc({ outcome: changeIds.length ? 'changed' : 'first_snapshot' });
    if (changeIds.length) {
      ctx.log.info({ resource: r.id, url: r.url, changes: changeIds.length }, 'changes detected');
      await enqueueWebhooks(ctx, r.id, Math.min(...changeIds) - 1, Math.max(...changeIds)).catch((err) =>
        ctx.log.error({ err, resource: r.id }, 'failed to enqueue webhooks'),
      );
    }
    return { ok: true, changed: changeIds.length > 0, changes: changeIds.length, notModified: false, firstSnapshot: !prevRow, suppressedLines: diff.suppressedLines };
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
