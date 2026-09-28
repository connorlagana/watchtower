/**
 * Check one resource: fetch politely, extract, compare with the previous
 * snapshot, and persist a new snapshot plus change events when it differs.
 */
import { robotsAllows } from '../fetch/robots.js';
import { FetchError, safeFetch } from '../fetch/safeFetch.js';
import { extract } from '../extract/adapters.js';
import { computeChanges, hashes } from '../extract/diff.js';
import type { AdapterName, Extraction } from '../extract/types.js';
import { fetchOptions, type Ctx } from './context.js';

export interface ResourceRow {
  id: string;
  url: string;
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
  | { ok: true; changed: boolean; changes: number; notModified: boolean; firstSnapshot: boolean }
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

const inFlight = new Map<string, Promise<CheckOutcome>>();

/** Deduplicates concurrent checks of the same resource within this process. */
export function checkResource(ctx: Ctx, resourceId: string): Promise<CheckOutcome> {
  let p = inFlight.get(resourceId);
  if (!p) {
    p = runCheck(ctx, resourceId).finally(() => inFlight.delete(resourceId));
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

async function runCheck(ctx: Ctx, resourceId: string): Promise<CheckOutcome> {
  const { rows } = await ctx.db.query<ResourceRow>('SELECT * FROM resources WHERE id = $1', [resourceId]);
  const r = rows[0];
  if (!r) return { ok: false, errorCode: 'NOT_FOUND', error: 'resource not found', permanent: true };
  const interval = await effectiveInterval(ctx, r.id);
  const opts = fetchOptions(ctx.config);

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

    if (res.notModified) {
      await ctx.db.query(
        `UPDATE resources SET last_checked_at = now(), last_status = 304, last_error = NULL, consecutive_failures = 0,
           next_check_at = now() + make_interval(secs => $2) WHERE id = $1`,
        [r.id, interval],
      );
      return { ok: true, changed: false, changes: 0, notModified: true, firstSnapshot: false };
    }

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

    let extraction: Extraction;
    try {
      extraction = extract(r.adapter, res.body, res.contentType, { baseUrl: res.finalUrl, selector: r.selector || undefined });
    } catch (err) {
      throw new CheckFailure('PARSE_ERROR', `could not parse response: ${(err as Error).message}`);
    }
    const { textHash, contentHash } = hashes(extraction);

    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      // Row lock serializes writers of this resource across processes.
      const locked = await client.query<{ current_snapshot_id: string | null }>(
        'SELECT current_snapshot_id FROM resources WHERE id = $1 FOR UPDATE',
        [r.id],
      );
      const currentId = locked.rows[0]?.current_snapshot_id ?? null;
      const prev = currentId
        ? (
            await client.query<{ content_hash: string; title: string | null; text: string; structured: { jobs?: []; events?: [] } }>(
              'SELECT content_hash, title, text, structured FROM snapshots WHERE id = $1',
              [currentId],
            )
          ).rows[0]
        : undefined;

      const common = [r.id, res.status, res.headers.etag ?? null, res.headers['last-modified'] ?? null, interval];
      if (prev && prev.content_hash === contentHash) {
        await client.query(
          `UPDATE resources SET last_checked_at = now(), last_status = $2, etag = $3, last_modified = $4, last_error = NULL,
             consecutive_failures = 0, next_check_at = now() + make_interval(secs => $5) WHERE id = $1`,
          common,
        );
        await client.query('COMMIT');
        return { ok: true, changed: false, changes: 0, notModified: false, firstSnapshot: false };
      }

      const snap = await client.query<{ id: string }>(
        `INSERT INTO snapshots (resource_id, status_code, content_type, content_hash, text_hash, title, text, structured)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [r.id, res.status, res.contentType || null, contentHash, textHash, extraction.title, extraction.text, JSON.stringify({ jobs: extraction.jobs, events: extraction.events })],
      );
      const snapshotId = snap.rows[0]!.id;
      const before: Extraction | null = prev
        ? { title: prev.title, text: prev.text, jobs: prev.structured.jobs ?? [], events: prev.structured.events ?? [] }
        : null;
      const changes = computeChanges(before, extraction);
      for (const c of changes) {
        await client.query(
          `INSERT INTO changes (resource_id, snapshot_id, type, item_key, summary, data, search_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [r.id, snapshotId, c.type, c.item_key, c.summary, JSON.stringify(c.data), c.search_text],
        );
      }
      await client.query(
        `UPDATE resources SET last_checked_at = now(), last_status = $2, etag = $3, last_modified = $4, last_error = NULL,
           consecutive_failures = 0, next_check_at = now() + make_interval(secs => $5),
           current_snapshot_id = $6, last_changed_at = CASE WHEN $7 THEN now() ELSE last_changed_at END
         WHERE id = $1`,
        [...common, snapshotId, changes.length > 0],
      );
      await client.query('COMMIT');
      if (changes.length) ctx.log.info({ resource: r.id, url: r.url, changes: changes.length }, 'changes detected');
      return { ok: true, changed: changes.length > 0, changes: changes.length, notModified: false, firstSnapshot: !prev };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const code = err instanceof CheckFailure || err instanceof FetchError ? err.code : 'INTERNAL_ERROR';
    const message = (err as Error).message;
    if (code === 'INTERNAL_ERROR') ctx.log.error({ err, resource: r.id }, 'check failed unexpectedly');
    const permanent = PERMANENT_ERRORS.has(code);
    const failures = r.consecutive_failures + 1;
    // Exponential backoff on failure, capped at a day; permanent refusals wait a full day.
    let delay = permanent ? DAY : Math.min(interval * 2 ** Math.min(failures, 6), DAY);
    const retryAfter = err instanceof CheckFailure ? err.retryAfterSeconds : undefined;
    if (retryAfter !== undefined) delay = Math.min(Math.max(delay, retryAfter), 7 * DAY);
    await ctx.db.query(
      `UPDATE resources SET last_checked_at = now(), last_error = $2, consecutive_failures = $3,
         next_check_at = now() + make_interval(secs => $4) WHERE id = $1`,
      [r.id, `${code}: ${message}`, failures, delay],
    );
    return { ok: false, errorCode: code, error: message, permanent };
  }
}
