import { promisify } from 'node:util';
import * as cheerio from 'cheerio';
import { canonicalUrl, resolveSource, type WatchKind } from '../extract/adapters.js';
import { CHANGE_TYPES_BY_KIND } from '../extract/diff.js';
import type { EventItem, JobItem } from '../extract/types.js';
import { createSafeLookup, validateUrl } from '../security/ssrf.js';
import { checkResource, type CheckOutcome, type ResourceRow } from './checker.js';
import type { Client } from './clients.js';
import { AppError, type Ctx } from './context.js';

export interface CreateWatchInput {
  kind: WatchKind;
  url: string;
  label?: string;
  keywords?: string[];
  selector?: string;
  interval_minutes?: number;
}

interface WatchRow {
  id: string;
  client_id: string;
  resource_id: string;
  kind: WatchKind;
  source_url: string;
  label: string | null;
  keywords: string[];
  change_types: string[];
  interval_seconds: number;
  baseline: number;
  cursor: number;
  created_at: Date;
}

type JoinedRow = WatchRow & {
  r_url: string;
  r_adapter: string;
  r_selector: string;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
  last_status: number | null;
  last_error: string | null;
  next_check_at: Date;
  s_title: string | null;
  s_fetched_at: Date | null;
  s_hash: string | null;
  s_text: string | null;
  s_structured: { jobs?: JobItem[]; events?: EventItem[] } | null;
  pending: number;
};

const MAX_KEYWORDS = 20;

function matchesKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

function presentWatch(row: JoinedRow, opts: { includeCurrent: boolean }) {
  const jobs = (row.s_structured?.jobs ?? []).filter((j) =>
    matchesKeywords([j.title, j.location, j.department, j.company].filter(Boolean).join(' '), row.keywords),
  );
  const events = (row.s_structured?.events ?? []).filter((e) => matchesKeywords([e.name, e.start_date, e.location].filter(Boolean).join(' '), row.keywords));
  const watch: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    url: row.source_url,
    label: row.label,
    keywords: row.keywords,
    change_types: row.change_types,
    interval_minutes: Math.round(row.interval_seconds / 60),
    created_at: row.created_at,
    pending_changes: Number(row.pending ?? 0),
    resource: {
      id: row.resource_id,
      fetch_url: row.r_url,
      adapter: row.r_adapter,
      selector: row.r_selector || null,
      last_checked_at: row.last_checked_at,
      last_changed_at: row.last_changed_at,
      last_status: row.last_status,
      last_error: row.last_error,
      next_check_at: row.next_check_at,
      healthy: row.last_error === null && row.s_hash !== null,
    },
    snapshot: row.s_hash
      ? {
          title: row.s_title,
          fetched_at: row.s_fetched_at,
          content_hash: row.s_hash,
          jobs_count: row.s_structured?.jobs?.length ?? 0,
          events_count: row.s_structured?.events?.length ?? 0,
        }
      : null,
  };
  if (opts.includeCurrent && row.s_hash) {
    if (row.kind === 'jobs') watch.current_jobs = jobs.slice(0, 50);
    else if (row.kind === 'events') watch.current_events = events.slice(0, 50);
    else watch.current_text_excerpt = (row.s_text ?? '').slice(0, 1500);
  }
  return watch;
}

const SELECT_JOINED = `
  SELECT w.*, r.url AS r_url, r.adapter AS r_adapter, r.selector AS r_selector,
         r.last_checked_at, r.last_changed_at, r.last_status, r.last_error, r.next_check_at,
         s.title AS s_title, s.fetched_at AS s_fetched_at, s.content_hash AS s_hash, s.text AS s_text, s.structured AS s_structured,
         (SELECT count(*) FROM changes c
            WHERE c.resource_id = w.resource_id AND c.id > w.cursor AND c.type = ANY(w.change_types)
              AND (cardinality(w.keywords) = 0 OR EXISTS (SELECT 1 FROM unnest(w.keywords) k WHERE position(k IN c.search_text) > 0))
         )::int AS pending
    FROM watches w
    JOIN resources r ON r.id = w.resource_id
    LEFT JOIN snapshots s ON s.id = r.current_snapshot_id`;

async function assertResolvesPublicly(ctx: Ctx, url: URL): Promise<void> {
  if (ctx.config.allowPrivateNetworks) return;
  const lookup = promisify(createSafeLookup({ allowPrivateNetworks: false, allowedPorts: [] }) as never) as (h: string, o: object) => Promise<unknown>;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    await lookup(host, { all: true });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') throw new AppError(400, 'DNS_FAILED', `could not resolve ${host}`);
    throw new AppError(400, 'URL_NOT_ALLOWED', e.message);
  }
}

export async function createWatch(ctx: Ctx, client: Client, input: CreateWatchInput) {
  let parsed: URL;
  try {
    parsed = validateUrl(input.url, { allowPrivateNetworks: ctx.config.allowPrivateNetworks, allowedPorts: ctx.config.allowedPorts });
  } catch (err) {
    throw new AppError(400, 'URL_NOT_ALLOWED', (err as Error).message);
  }
  await assertResolvesPublicly(ctx, parsed);

  const source = resolveSource(parsed.toString(), input.kind);
  const keywords = [...new Set((input.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_KEYWORDS);
  const selector = input.kind === 'url' ? (input.selector ?? '').trim().slice(0, 300) : '';
  if (selector) {
    try {
      cheerio.load('<div></div>')(selector);
    } catch {
      throw new AppError(400, 'INVALID_SELECTOR', `invalid CSS selector "${selector}"`);
    }
  }
  const requested = (input.interval_minutes ?? ctx.config.defaultCheckIntervalSeconds / 60) * 60;
  const intervalSeconds = Math.round(Math.min(Math.max(requested, ctx.config.minCheckIntervalSeconds), 7 * 86_400));

  const db = await ctx.db.connect();
  let watchId: string;
  let resource: ResourceRow;
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [client.id]);
    const { rows: countRows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM watches WHERE client_id = $1 AND deleted_at IS NULL',
      [client.id],
    );
    if ((countRows[0]?.n ?? 0) >= ctx.config.maxWatchesPerClient) {
      throw new AppError(409, 'WATCH_LIMIT', `each client may have at most ${ctx.config.maxWatchesPerClient} active watches; delete one first`);
    }
    const res = await db.query<ResourceRow>(
      `INSERT INTO resources (url, selector, adapter) VALUES ($1, $2, $3)
       ON CONFLICT (url, selector, adapter) DO UPDATE SET url = EXCLUDED.url
       RETURNING *`,
      [source.fetchUrl, selector, source.adapter],
    );
    resource = res.rows[0]!;
    const { rows: maxRows } = await db.query<{ m: number | null }>('SELECT max(id) AS m FROM changes WHERE resource_id = $1', [resource.id]);
    const baseline = maxRows[0]?.m ?? 0;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO watches (client_id, resource_id, kind, source_url, label, keywords, change_types, interval_seconds, baseline, cursor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
      [client.id, resource.id, input.kind, canonicalUrl(parsed.toString()), input.label?.slice(0, 200) ?? null, keywords, CHANGE_TYPES_BY_KIND[input.kind], intervalSeconds, baseline],
    );
    watchId = rows[0]!.id;
    // A shorter interval on a shared resource should take effect promptly.
    await db.query(
      `UPDATE resources SET next_check_at = LEAST(next_check_at, COALESCE(last_checked_at, now()) + make_interval(secs => $2)) WHERE id = $1`,
      [resource.id, intervalSeconds],
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }

  // First watcher of a resource takes the initial snapshot synchronously so the
  // caller immediately learns whether the URL is monitorable.
  let initial: CheckOutcome | null = null;
  if (!resource.current_snapshot_id) {
    initial = await checkResource(ctx, resource.id);
    if (!initial.ok && initial.permanent) {
      await ctx.db.query('UPDATE watches SET deleted_at = now() WHERE id = $1', [watchId]);
      throw new AppError(422, initial.errorCode, `cannot monitor this URL: ${initial.error}`);
    }
  }
  const watch = await getWatch(ctx, client, watchId, { includeCurrent: true });
  return {
    ...watch,
    initial_check: initial
      ? initial.ok
        ? { ok: true, snapshot_taken: true }
        : { ok: false, error_code: initial.errorCode, error: initial.error, note: 'will retry automatically with backoff' }
      : { ok: true, shared_resource: true, note: 'another watch already monitors this resource; reusing its snapshot' },
  };
}

export async function getWatch(ctx: Ctx, client: Client, id: string, opts = { includeCurrent: true }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  const { rows } = await ctx.db.query<JoinedRow>(`${SELECT_JOINED} WHERE w.id = $1 AND w.client_id = $2 AND w.deleted_at IS NULL`, [id, client.id]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  return presentWatch(rows[0], opts);
}

export async function listWatches(ctx: Ctx, client: Client) {
  const { rows } = await ctx.db.query<JoinedRow>(`${SELECT_JOINED} WHERE w.client_id = $1 AND w.deleted_at IS NULL ORDER BY w.created_at`, [client.id]);
  return { watches: rows.map((r) => presentWatch(r, { includeCurrent: false })), limit: ctx.config.maxWatchesPerClient };
}

export async function deleteWatch(ctx: Ctx, client: Client, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  const { rowCount } = await ctx.db.query('UPDATE watches SET deleted_at = now() WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL', [id, client.id]);
  if (!rowCount) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  return { deleted: true, id };
}

/** Force a check now, subject to the minimum interval so clients can't turn Watchtower into a crawler. */
export async function checkNow(ctx: Ctx, client: Client, id: string) {
  const watch = await getWatch(ctx, client, id, { includeCurrent: false });
  const resourceId = (watch.resource as { id: string }).id;
  const { rows } = await ctx.db.query<{ age: number | null }>(
    'SELECT extract(epoch FROM now() - last_checked_at)::float AS age FROM resources WHERE id = $1',
    [resourceId],
  );
  const age = rows[0]?.age;
  if (age !== null && age !== undefined && age < ctx.config.minCheckIntervalSeconds) {
    throw new AppError(429, 'TOO_SOON', `resource was checked ${Math.round(age)}s ago; minimum interval is ${ctx.config.minCheckIntervalSeconds}s`);
  }
  const outcome = await checkResource(ctx, resourceId);
  return { check: outcome, watch: await getWatch(ctx, client, id) };
}

export interface GetChangesInput {
  watch_id?: string;
  /** Replay from this cursor instead of the watch's stored cursor. */
  since?: number;
  limit?: number;
  /** When true, do not advance the stored cursor. */
  peek?: boolean;
}

interface ChangeRow {
  id: number;
  type: string;
  summary: string;
  data: Record<string, unknown>;
  detected_at: Date;
  watch_id: string;
  label: string | null;
  kind: string;
  source_url: string;
}

export async function getChanges(ctx: Ctx, client: Client, input: GetChangesInput) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  if (input.watch_id) await getWatch(ctx, client, input.watch_id, { includeCurrent: false }); // 404 if not ours
  const { rows: maxRows } = await ctx.db.query<{ m: number | null }>('SELECT max(id) AS m FROM changes');
  const maxId = maxRows[0]?.m ?? 0;
  const since = input.since ?? null;

  const { rows } = await ctx.db.query<ChangeRow>(
    `SELECT c.id, c.type, c.summary, c.data, c.detected_at, w.id AS watch_id, w.label, w.kind, w.source_url
       FROM watches w
       JOIN changes c ON c.resource_id = w.resource_id
      WHERE w.client_id = $1 AND w.deleted_at IS NULL
        AND ($2::uuid IS NULL OR w.id = $2)
        AND c.id > CASE WHEN $3::bigint IS NULL THEN w.cursor ELSE GREATEST(w.baseline, $3::bigint) END
        AND c.id <= $4
        AND c.type = ANY(w.change_types)
        AND (cardinality(w.keywords) = 0 OR EXISTS (SELECT 1 FROM unnest(w.keywords) k WHERE position(k IN c.search_text) > 0))
      ORDER BY c.id, w.id
      LIMIT $5`,
    [client.id, input.watch_id ?? null, since, maxId, limit + 1],
  );

  let kept = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  if (hasMore) {
    // Never split one change id across pages (it can fan out to several of this client's watches).
    const lastId = kept[kept.length - 1]!.id;
    if (rows[limit]!.id === lastId) {
      const trimmed = kept.filter((r) => r.id < lastId);
      if (trimmed.length) kept = trimmed;
    }
  }
  const cursor = hasMore ? kept[kept.length - 1]!.id : maxId;

  if (!input.peek) {
    await ctx.db.query(
      `UPDATE watches SET cursor = GREATEST(cursor, $3) WHERE client_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2)`,
      [client.id, input.watch_id ?? null, cursor],
    );
  }

  return {
    changes: kept.map((r) => ({
      id: r.id,
      watch_id: r.watch_id,
      watch_label: r.label,
      watch_kind: r.kind,
      url: r.source_url,
      type: r.type,
      summary: r.summary,
      detected_at: r.detected_at,
      data: r.data,
    })),
    cursor,
    has_more: hasMore,
    advanced: !input.peek,
  };
}
