import { promisify } from 'node:util';
import { canonicalUrl, resolveSource } from '../extract/adapters.js';
import { JOB_CHANGE_TYPES, jobSearch } from '../extract/diff.js';
import { termMatch } from '../extract/match.js';
import { safeFetch } from '../fetch/safeFetch.js';
import { detectBoardLinks } from '../search/discover.js';
import { parseQuery } from '../search/query.js';
import { PLATFORM_ADAPTERS, SENIORITIES, type JobItem, type Seniority } from '../extract/types.js';
import { createSafeLookup, validateUrl } from '../security/ssrf.js';
import { checkResource, type CheckOutcome, type ResourceRow } from './checker.js';
import type { Client } from './clients.js';
import { promoteToDirectory } from './boardIndex.js';
import { acquireHostWaiting, releaseHost } from './hostLease.js';
import { AppError, fetchOptions, jobFilterSql, jobTextSql, RESOURCE_IS_MONITORED, WATCH_READS_RESOURCE, WATCH_SEES_CHANGE, type Ctx } from './context.js';
import { newWebhookSecret } from './webhooks.js';

/** Filters as a caller supplies them. Anything given here wins over what `query` says. */
export interface JobFilters {
  /**
   * A plain-language request, e.g. "iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience".
   * It is read into the filters below; the response shows the reading.
   */
  query?: string;
  /** Report only jobs whose title/location/department/company contains one of these (whole words, case-insensitive). */
  keywords?: string[];
  /** Report only jobs containing every one of these. */
  all_keywords?: string[];
  /** Never report jobs mentioning one of these. */
  exclude_keywords?: string[];
  /** Report only jobs with one of these in their location(s). */
  locations?: string[];
  seniority?: Seniority[];
  remote_only?: boolean;
  /** Yearly pay the job's stated range must reach. */
  min_salary?: number;
  /** Only compare against pay stated in this currency (ISO code). */
  salary_currency?: string;
  /** The most years of experience the job may ask for. */
  max_experience_years?: number;
  /** Keep jobs that do not state pay / experience when filtering on them (default true). */
  include_unknown?: boolean;
}

/** Filters as stored on a watch. */
export interface WatchFilters {
  keywords: string[];
  all_keywords: string[];
  exclude_keywords: string[];
  locations: string[];
  seniority: Seniority[];
  remote_only: boolean;
  min_salary: number | null;
  salary_currency: string | null;
  max_experience_years: number | null;
  include_unknown: boolean;
}

export interface CreateWatchInput extends JobFilters {
  url: string;
  label?: string;
  interval_minutes?: number;
  /** Where to POST matching changes (optional; polling get_changes always works). */
  webhook_url?: string;
}

export type CreateSearchWatchInput = Omit<CreateWatchInput, 'url' | 'interval_minutes'>;

interface WatchRow {
  id: string;
  client_id: string;
  resource_id: string | null;
  source_url: string | null;
  query: string | null;
  label: string | null;
  keywords: string[];
  all_keywords: string[];
  exclude_keywords: string[];
  locations: string[];
  seniority: Seniority[];
  remote_only: boolean;
  min_salary: number | null;
  salary_currency: string | null;
  max_experience_years: number | null;
  include_unknown: boolean;
  change_types: string[];
  interval_seconds: number;
  baseline: number;
  cursor: number;
  created_at: Date;
  last_accessed_at: Date;
  webhook_url: string | null;
}

type JoinedRow = WatchRow & {
  r_url: string | null;
  r_adapter: string | null;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
  last_status: number | null;
  last_error: string | null;
  next_check_at: Date | null;
  s_fetched_at: Date | null;
  s_hash: string | null;
  s_structured: { jobs?: JobItem[]; complete?: boolean } | null;
  pending: number;
};

const MAX_KEYWORDS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeTerms = (terms: string[] | undefined) => [...new Set((terms ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_KEYWORDS);

/**
 * The stored filters for a request: the plain-language `query` is read first,
 * then every filter the caller passed explicitly replaces what the query said.
 */
export function buildFilters(input: JobFilters): { filters: WatchFilters; query: string | null; notes: string[] } {
  const query = input.query?.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  const parsed = query ? parseQuery(query) : null;
  const terms = (given: string[] | undefined, read: string[] | undefined) => normalizeTerms(given ?? read);
  const positive = (given: number | undefined, read: number | undefined, max: number) => {
    const n = given ?? read;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : null;
  };
  const currency = (input.salary_currency ?? parsed?.salary_currency)?.trim().toUpperCase();
  const filters: WatchFilters = {
    keywords: terms(input.keywords, parsed?.keywords),
    all_keywords: terms(input.all_keywords, parsed?.all_keywords),
    exclude_keywords: terms(input.exclude_keywords, parsed?.exclude_keywords),
    locations: terms(input.locations, parsed?.locations),
    seniority: [...new Set((input.seniority ?? parsed?.seniority ?? []).filter((x) => (SENIORITIES as readonly string[]).includes(x)))],
    remote_only: input.remote_only ?? parsed?.remote_only ?? false,
    min_salary: positive(input.min_salary, parsed?.min_salary, 100_000_000) || null,
    salary_currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    max_experience_years: positive(input.max_experience_years, parsed?.max_experience_years, 60),
    include_unknown: input.include_unknown !== false,
  };
  // Explicit keywords replace the query's reading of the role in either form.
  if (input.keywords && !input.all_keywords) filters.all_keywords = [];
  if (input.all_keywords && !input.keywords) filters.keywords = [];
  if (filters.min_salary === null) filters.salary_currency = null;
  return { filters, query, notes: parsed?.notes ?? [] };
}

const hasCriteria = (f: WatchFilters) =>
  f.keywords.length > 0 || f.all_keywords.length > 0 || f.locations.length > 0 || f.seniority.length > 0 || f.remote_only || f.min_salary !== null || f.max_experience_years !== null;

/** The JS twin of jobFilterSql(), for the current job list. */
export function jobMatches(job: JobItem, w: WatchFilters): boolean {
  const text = jobSearch(job);
  const location = `${job.location ?? ''} ${(job.other_locations ?? []).join(' | ')}`.toLowerCase();
  const pay = job.salary?.annual_max ?? job.salary?.annual_min;
  return (
    (w.keywords.length === 0 || w.keywords.some((k) => termMatch(text, k))) &&
    w.all_keywords.every((k) => termMatch(text, k)) &&
    !w.exclude_keywords.some((k) => termMatch(text, k)) &&
    (!w.remote_only || job.remote === true) &&
    (w.locations.length === 0 || w.locations.some((l) => termMatch(location, l))) &&
    (w.seniority.length === 0 || (job.seniority !== undefined && w.seniority.includes(job.seniority))) &&
    (w.min_salary === null ||
      (pay === undefined ? w.include_unknown : pay >= w.min_salary && (w.salary_currency === null || (job.salary?.currency ?? w.salary_currency) === w.salary_currency))) &&
    (w.max_experience_years === null || (job.experience_years === undefined ? w.include_unknown : job.experience_years <= w.max_experience_years))
  );
}

const filtersOf = (row: WatchRow): WatchFilters => ({
  keywords: row.keywords,
  all_keywords: row.all_keywords,
  exclude_keywords: row.exclude_keywords,
  locations: row.locations,
  seniority: row.seniority,
  remote_only: row.remote_only,
  min_salary: row.min_salary,
  salary_currency: row.salary_currency,
  max_experience_years: row.max_experience_years,
  include_unknown: row.include_unknown,
});

const MAX_CURRENT_JOBS = 50;

/** Fields every watch has, whatever it covers. */
function presentCommon(ctx: Ctx, row: JoinedRow) {
  return {
    id: row.id,
    scope: row.resource_id ? 'board' : 'all_boards',
    url: row.source_url,
    query: row.query,
    label: row.label,
    filters: filtersOf(row),
    webhook_url: row.webhook_url,
    change_types: row.change_types,
    created_at: row.created_at,
    // Reading a watch (get_changes/get_watch/list_watches) or a successful webhook delivery renews it.
    expires_at: new Date(new Date(row.last_accessed_at).getTime() + ctx.config.watchTtlDays * 86_400_000),
    pending_changes: Number(row.pending ?? 0),
  };
}

function presentWatch(ctx: Ctx, row: JoinedRow, opts: { includeCurrent: boolean }) {
  const allJobs = row.s_structured?.jobs ?? [];
  const filters = filtersOf(row);
  const jobs = allJobs.filter((j) => jobMatches(j, filters));
  const watch: Record<string, unknown> = {
    ...presentCommon(ctx, row),
    interval_minutes: Math.round(row.interval_seconds / 60),
    resource: {
      id: row.resource_id,
      fetch_url: row.r_url,
      adapter: row.r_adapter,
      last_checked_at: row.last_checked_at,
      last_changed_at: row.last_changed_at,
      last_status: row.last_status,
      last_error: row.last_error,
      next_check_at: row.next_check_at,
      healthy: row.last_error === null && row.s_hash !== null,
    },
    snapshot: row.s_hash
      ? {
          fetched_at: row.s_fetched_at,
          content_hash: row.s_hash,
          jobs_count: allJobs.length,
          matching_jobs_count: jobs.length,
          complete: row.s_structured?.complete !== false,
        }
      : null,
  };
  if (opts.includeCurrent && row.s_hash) watch.current_jobs = jobs.slice(0, MAX_CURRENT_JOBS);
  return watch;
}

/** How many boards a search watch is matched against right now. */
async function coverage(ctx: Ctx) {
  const { rows } = await ctx.db.query<{ boards: number; pending: number }>(
    `SELECT count(*) FILTER (WHERE r.current_snapshot_id IS NOT NULL)::int AS boards,
            count(*) FILTER (WHERE r.current_snapshot_id IS NULL)::int AS pending
       FROM resources r WHERE ${RESOURCE_IS_MONITORED}`,
  );
  return {
    boards: rows[0]?.boards ?? 0,
    boards_awaiting_first_check: rows[0]?.pending ?? 0,
    note: 'A search watch reports new postings on every board Watchtower monitors: its built-in directory plus any board someone watches by URL. To cover a company that is missing, call watch_jobs with its board URL.',
  };
}

/** Jobs open right now, on any monitored board, that pass a search watch's filters (newest first). */
async function searchCurrentJobs(ctx: Ctx, watchId: string, limit: number): Promise<{ jobs: JobItem[]; total: number }> {
  const { rows } = await ctx.db.query<{ job: JobItem; total: number }>(
    `SELECT j.job, (count(*) OVER ())::int AS total
       FROM watches w
       JOIN resources r ON ${RESOURCE_IS_MONITORED}
       JOIN snapshots s ON s.id = r.current_snapshot_id
      CROSS JOIN LATERAL jsonb_array_elements(s.structured -> 'jobs') AS j(job)
      WHERE w.id = $1 AND ${jobFilterSql('j.job', jobTextSql('j.job'))}
      ORDER BY j.job ->> 'posted_at' DESC NULLS LAST, j.job ->> 'key'
      LIMIT $2`,
    [watchId, limit],
  );
  return { jobs: rows.map((r) => r.job), total: rows[0]?.total ?? 0 };
}

async function presentSearchWatch(ctx: Ctx, row: JoinedRow, opts: { includeCurrent: boolean }, shared?: Awaited<ReturnType<typeof coverage>>) {
  const watch: Record<string, unknown> = { ...presentCommon(ctx, row), resource: null, snapshot: null, coverage: shared ?? (await coverage(ctx)) };
  if (opts.includeCurrent) {
    const current = await searchCurrentJobs(ctx, row.id, MAX_CURRENT_JOBS);
    watch.matching_jobs_count = current.total;
    watch.current_jobs = current.jobs;
  }
  return watch;
}

const SELECT_JOINED = `
  SELECT w.*, r.url AS r_url, r.adapter AS r_adapter,
         r.last_checked_at, r.last_changed_at, r.last_status, r.last_error, r.next_check_at,
         s.fetched_at AS s_fetched_at, s.content_hash AS s_hash, s.structured AS s_structured,
         (SELECT count(*) FROM changes c WHERE ${WATCH_READS_RESOURCE} AND c.id > w.cursor AND ${WATCH_SEES_CHANGE})::int AS pending
    FROM watches w
    LEFT JOIN resources r ON r.id = w.resource_id
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

async function validatePublicUrl(ctx: Ctx, raw: string, code: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = validateUrl(raw, { allowPrivateNetworks: ctx.config.allowPrivateNetworks, allowedPorts: ctx.config.allowedPorts });
  } catch (err) {
    throw new AppError(400, code, (err as Error).message);
  }
  await assertResolvesPublicly(ctx, parsed);
  return parsed;
}

/** The supported job board a careers page links to or embeds, if any. One extra, lease-respecting request to that page. */
async function linkedBoard(ctx: Ctx, page: ResourceRow): Promise<string | null> {
  const opts = fetchOptions(ctx.config);
  if (!(await acquireHostWaiting(ctx.db, page.host, opts.timeoutMs + 5000, Math.min(10_000, opts.timeoutMs)))) return null;
  try {
    const res = await safeFetch(page.url, opts);
    return res.status === 200 ? (detectBoardLinks(res.body)[0] ?? null) : null;
  } catch {
    return null;
  } finally {
    await releaseHost(ctx.db, page.host, ctx.config.hostMinSpacingMs).catch(() => {});
  }
}

const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');

export async function createWatch(ctx: Ctx, client: Client, input: CreateWatchInput): Promise<Record<string, unknown>> {
  const parsed = await validatePublicUrl(ctx, input.url, 'URL_NOT_ALLOWED');
  const webhookUrl = input.webhook_url ? (await validatePublicUrl(ctx, input.webhook_url, 'WEBHOOK_URL_NOT_ALLOWED')).toString() : null;

  const source = resolveSource(parsed.toString());
  const host = hostOf(source.fetchUrl);
  const { filters, query, notes } = buildFilters(input);
  // Resources keep a selector column from the page-watch era; job resources never narrow by one.
  const selector = '';
  const requested = (input.interval_minutes ?? ctx.config.defaultCheckIntervalSeconds / 60) * 60;
  const intervalSeconds = Math.round(Math.min(Math.max(requested, ctx.config.minCheckIntervalSeconds), 7 * 86_400));
  const webhookSecret = webhookUrl ? newWebhookSecret() : null;

  const db = await ctx.db.connect();
  let watchId: string;
  let resource: ResourceRow;
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [client.id]);
    const { rows: counts } = await db.query<{ total: number; on_host: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.host = $2 AND r.adapter = 'html')::int AS on_host
         FROM watches w JOIN resources r ON r.id = w.resource_id
        WHERE w.client_id = $1 AND w.deleted_at IS NULL`,
      [client.id, host],
    );
    if ((counts[0]?.total ?? 0) >= ctx.config.maxWatchesPerClient) {
      throw new AppError(409, 'WATCH_LIMIT', `each client may have at most ${ctx.config.maxWatchesPerClient} active watches; delete one first`);
    }
    // Boards on a platform share its API host but are different companies; the per-host cap is for arbitrary sites.
    if (!PLATFORM_ADAPTERS.has(source.adapter) && (counts[0]?.on_host ?? 0) >= ctx.config.maxWatchesPerClientPerHost) {
      throw new AppError(409, 'HOST_WATCH_LIMIT', `each client may have at most ${ctx.config.maxWatchesPerClientPerHost} watches on ${host}`);
    }

    const existing = await db.query<ResourceRow>('SELECT * FROM resources WHERE url = $1 AND selector = $2 AND adapter = $3', [source.fetchUrl, selector, source.adapter]);
    const reusable = existing.rows[0];
    if (!reusable || !(await hasActiveWatch(db, reusable.id))) {
      // A new (or revived) resource costs fetches: enforce global and per-host capacity.
      const { rows: cap } = await db.query<{ total: number; on_host: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.host = $1)::int AS on_host
           FROM resources r WHERE EXISTS (SELECT 1 FROM watches w WHERE w.resource_id = r.id AND w.deleted_at IS NULL)`,
        [host],
      );
      if ((cap[0]?.total ?? 0) >= ctx.config.maxActiveResources) {
        throw new AppError(503, 'CAPACITY', 'Watchtower is at capacity for new resources; try again later or watch an already-monitored URL');
      }
      // Platform job-board APIs are built for this traffic; arbitrary sites get a per-host cap.
      if (!PLATFORM_ADAPTERS.has(source.adapter) && (cap[0]?.on_host ?? 0) >= ctx.config.maxResourcesPerHost) {
        throw new AppError(429, 'HOST_CAPACITY', `too many distinct URLs on ${host} are already monitored; watch one of the existing pages`);
      }
    }

    const res = await db.query<ResourceRow>(
      `INSERT INTO resources (url, host, selector, adapter) VALUES ($1, $2, $3, $4)
       ON CONFLICT (url, selector, adapter) DO UPDATE SET url = EXCLUDED.url
       RETURNING *`,
      [source.fetchUrl, host, selector, source.adapter],
    );
    resource = res.rows[0]!;
    const { rows: maxRows } = await db.query<{ m: number | null }>('SELECT max(id) AS m FROM changes WHERE resource_id = $1', [resource.id]);
    const baseline = maxRows[0]?.m ?? 0;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO watches (${WATCH_COLUMNS}) VALUES (${WATCH_PLACEHOLDERS}) RETURNING id`,
      watchValues({
        clientId: client.id,
        resourceId: resource.id,
        kind: 'jobs',
        sourceUrl: canonicalUrl(parsed.toString()),
        query,
        label: input.label,
        filters,
        changeTypes: JOB_CHANGE_TYPES,
        intervalSeconds,
        baseline,
        webhookUrl,
        webhookSecret,
      }),
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
    initial = await checkResource(ctx, resource.id, { waitForHost: true });
    if (!initial.ok && initial.permanent) {
      await ctx.db.query("UPDATE watches SET deleted_at = now(), delete_reason = 'unmonitorable' WHERE id = $1", [watchId]);
      throw new AppError(422, initial.errorCode, `cannot monitor this URL: ${initial.error}`);
    }
    // A careers page on no supported platform and without JobPosting markup would never report anything.
    if (initial.ok && initial.jobs === 0 && !PLATFORM_ADAPTERS.has(resource.adapter)) {
      await ctx.db.query("UPDATE watches SET deleted_at = now(), delete_reason = 'no_job_data' WHERE id = $1", [watchId]);
      // Most such pages only link to (or embed) the company's board on a platform: watch that board instead.
      const board = await linkedBoard(ctx, resource);
      if (board) {
        const watch = await createWatch(ctx, client, { ...input, url: board });
        return { ...watch, resolved_from: { url: canonicalUrl(parsed.toString()), note: `this page has no job data of its own; it links to ${board}, which is watched instead` } };
      }
      throw new AppError(
        422,
        'NO_JOB_DATA',
        'no job postings found at this URL. Watchtower reads Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Workday and iCIMS boards, ' +
          'and other careers pages that publish schema.org JobPosting markup. If the company uses one of those platforms, pass the board URL instead.',
      );
    }
  }
  // A platform board someone cared enough to watch is worth covering for every search watch.
  if (PLATFORM_ADAPTERS.has(resource.adapter)) await promoteToDirectory(ctx, resource.id).catch((err) => ctx.log.error({ err }, 'failed to add board to the directory'));
  const watch = await getWatch(ctx, client, watchId, { includeCurrent: true });
  return {
    ...watch,
    ...interpretation(query, filters, notes),
    ...webhookNote(webhookSecret),
    initial_check: initial
      ? initial.ok
        ? { ok: true, snapshot_taken: true }
        : initial.errorCode === 'HOST_BUSY'
          ? { ok: false, error_code: 'HOST_BUSY', note: 'the host is busy; the initial snapshot will be taken within seconds' }
          : { ok: false, error_code: initial.errorCode, error: initial.error, note: 'will retry automatically with backoff' }
      : { ok: true, shared_resource: true, note: 'another watch already monitors this resource; reusing its snapshot' },
  };
}

const WATCH_COLUMNS = `client_id, resource_id, kind, source_url, query, label, keywords, all_keywords, exclude_keywords, locations, seniority, remote_only,
  min_salary, salary_currency, max_experience_years, include_unknown, change_types, interval_seconds, baseline, cursor, webhook_url, webhook_secret`;
const WATCH_PLACEHOLDERS = '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $21';

function watchValues(v: {
  clientId: string;
  resourceId: string | null;
  kind: 'jobs' | 'search';
  sourceUrl: string | null;
  query: string | null;
  label: string | undefined;
  filters: WatchFilters;
  changeTypes: string[];
  intervalSeconds: number;
  baseline: number;
  webhookUrl: string | null;
  webhookSecret: string | null;
}): unknown[] {
  const f = v.filters;
  return [
    v.clientId,
    v.resourceId,
    v.kind,
    v.sourceUrl,
    v.query,
    v.label?.slice(0, 200) ?? null,
    f.keywords,
    f.all_keywords,
    f.exclude_keywords,
    f.locations,
    f.seniority,
    f.remote_only,
    f.min_salary,
    f.salary_currency,
    f.max_experience_years,
    f.include_unknown,
    v.changeTypes,
    v.intervalSeconds,
    v.baseline,
    v.webhookUrl,
    v.webhookSecret,
  ];
}

const webhookNote = (secret: string | null) =>
  secret ? { webhook_secret: secret, webhook_note: 'Verify deliveries with this secret (HMAC-SHA256 of "<x-watchtower-timestamp>.<body>"). Shown only once.' } : {};

/** Shown on creation when a query was given, so the caller can check the reading and correct it with explicit filters. */
const interpretation = (query: string | null, filters: WatchFilters, notes: string[]) =>
  query
    ? {
        interpreted: {
          query,
          filters,
          notes,
          how_to_correct: 'If this reading is wrong, delete the watch and create it again with explicit filters; they override the query.',
        },
      }
    : {};

/**
 * Watch new postings across every monitored board, with no URL: the watch is
 * its filters. It reads the same change events board watches do, from all
 * resources, and only reports JOB_ADDED.
 */
export async function createSearchWatch(ctx: Ctx, client: Client, input: CreateSearchWatchInput) {
  const { filters, query, notes } = buildFilters(input);
  if (!hasCriteria(filters)) {
    throw new AppError(
      400,
      'QUERY_TOO_BROAD',
      'a watch without a url needs at least one filter: say what to look for in query (e.g. "iOS jobs in Austin making at least 150k"), or pass keywords, locations, seniority, remote_only, min_salary or max_experience_years',
    );
  }
  const webhookUrl = input.webhook_url ? (await validatePublicUrl(ctx, input.webhook_url, 'WEBHOOK_URL_NOT_ALLOWED')).toString() : null;
  const webhookSecret = webhookUrl ? newWebhookSecret() : null;

  const db = await ctx.db.connect();
  let watchId: string;
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [client.id]);
    const { rows: counts } = await db.query<{ total: number }>('SELECT count(*)::int AS total FROM watches WHERE client_id = $1 AND deleted_at IS NULL', [client.id]);
    if ((counts[0]?.total ?? 0) >= ctx.config.maxWatchesPerClient) {
      throw new AppError(409, 'WATCH_LIMIT', `each client may have at most ${ctx.config.maxWatchesPerClient} active watches; delete one first`);
    }
    // Only postings that appear after this point are reported.
    const { rows: maxRows } = await db.query<{ m: number | null }>('SELECT max(id) AS m FROM changes');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO watches (${WATCH_COLUMNS}) VALUES (${WATCH_PLACEHOLDERS}) RETURNING id`,
      watchValues({
        clientId: client.id,
        resourceId: null,
        kind: 'search',
        sourceUrl: null,
        query,
        label: input.label,
        filters,
        changeTypes: ['JOB_ADDED'],
        intervalSeconds: ctx.config.indexCheckIntervalSeconds,
        baseline: maxRows[0]?.m ?? 0,
        webhookUrl,
        webhookSecret,
      }),
    );
    watchId = rows[0]!.id;
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  const watch = await getWatch(ctx, client, watchId, { includeCurrent: true });
  return { ...watch, ...interpretation(query, filters, notes), ...webhookNote(webhookSecret) };
}

export const MAX_BATCH_URLS = 25;

/**
 * Watch several boards with the same filters in one call. Each URL succeeds or
 * fails on its own; the initial snapshots run concurrently, and boards on a
 * busy host are deferred to the scheduler rather than waited for.
 */
export async function createWatches(ctx: Ctx, client: Client, input: Omit<CreateWatchInput, 'url'> & { urls: string[] }) {
  const urls = [...new Set(input.urls)].slice(0, MAX_BATCH_URLS);
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        return { url, watch: await createWatch(ctx, client, { ...input, url }) };
      } catch (err) {
        const e = err instanceof AppError ? err : new AppError(500, 'INTERNAL_ERROR', 'internal error');
        if (e.code === 'INTERNAL_ERROR') ctx.log.error({ err, url }, 'batch watch creation failed');
        return { url, error: e.code, message: e.message };
      }
    }),
  );
  return {
    watches: results.filter((r) => 'watch' in r).map((r) => r.watch),
    errors: results.filter((r) => 'error' in r),
  };
}

async function hasActiveWatch(db: { query: Ctx['db']['query'] }, resourceId: string): Promise<boolean> {
  const { rows } = await db.query<{ x: number }>('SELECT 1 AS x FROM watches WHERE resource_id = $1 AND deleted_at IS NULL LIMIT 1', [resourceId]);
  return rows.length > 0;
}

async function touch(ctx: Ctx, client: Client, watchId?: string | null) {
  await ctx.db.query(
    `UPDATE watches SET last_accessed_at = now()
      WHERE client_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2) AND last_accessed_at < now() - interval '1 minute'`,
    [client.id, watchId ?? null],
  );
}

export async function getWatch(ctx: Ctx, client: Client, id: string, opts = { includeCurrent: true }) {
  if (!UUID.test(id)) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  const { rows } = await ctx.db.query<JoinedRow>(`${SELECT_JOINED} WHERE w.id = $1 AND w.client_id = $2 AND w.deleted_at IS NULL`, [id, client.id]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  await touch(ctx, client, id);
  return rows[0].resource_id ? presentWatch(ctx, rows[0], opts) : presentSearchWatch(ctx, rows[0], opts);
}

export async function listWatches(ctx: Ctx, client: Client) {
  const { rows } = await ctx.db.query<JoinedRow>(`${SELECT_JOINED} WHERE w.client_id = $1 AND w.deleted_at IS NULL ORDER BY w.created_at`, [client.id]);
  await touch(ctx, client);
  const shared = rows.some((r) => !r.resource_id) ? await coverage(ctx) : undefined;
  const watches = await Promise.all(rows.map((r) => (r.resource_id ? presentWatch(ctx, r, { includeCurrent: false }) : presentSearchWatch(ctx, r, { includeCurrent: false }, shared))));
  return { watches, limit: ctx.config.maxWatchesPerClient };
}

export async function deleteWatch(ctx: Ctx, client: Client, id: string) {
  if (!UUID.test(id)) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  const { rowCount } = await ctx.db.query(
    "UPDATE watches SET deleted_at = now(), delete_reason = 'deleted' WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL",
    [id, client.id],
  );
  if (!rowCount) throw new AppError(404, 'NOT_FOUND', 'watch not found');
  return { deleted: true, id };
}

/** Force a check now, subject to the minimum interval so clients can't turn Watchtower into a crawler. */
export async function checkNow(ctx: Ctx, client: Client, id: string) {
  const watch = await getWatch(ctx, client, id, { includeCurrent: false });
  const resourceId = (watch.resource as { id: string } | null)?.id;
  if (!resourceId) throw new AppError(400, 'NOT_SUPPORTED', 'a search watch covers every monitored board, which Watchtower checks on its own schedule; there is no single board to check');
  const { rows } = await ctx.db.query<{ age: number | null }>(
    'SELECT extract(epoch FROM now() - last_checked_at)::float AS age FROM resources WHERE id = $1',
    [resourceId],
  );
  const age = rows[0]?.age;
  if (age !== null && age !== undefined && age < ctx.config.minCheckIntervalSeconds) {
    throw new AppError(429, 'TOO_SOON', `resource was checked ${Math.round(age)}s ago; minimum interval is ${ctx.config.minCheckIntervalSeconds}s`);
  }
  const outcome = await checkResource(ctx, resourceId, { waitForHost: true });
  return { check: outcome, watch: await getWatch(ctx, client, id) };
}

export interface GetChangesInput {
  watch_id?: string;
  /** Replay from this cursor instead of the watch's stored cursor. */
  since?: number;
  limit?: number;
  /** When true, do not advance the stored cursor (use ack_changes afterwards for at-least-once delivery). */
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
  source_url: string | null;
}

export async function getChanges(ctx: Ctx, client: Client, input: GetChangesInput) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  if (input.watch_id) await getWatch(ctx, client, input.watch_id, { includeCurrent: false }); // 404 if not ours
  else await touch(ctx, client);
  const { rows: maxRows } = await ctx.db.query<{ m: number | null }>('SELECT max(id) AS m FROM changes');
  const maxId = maxRows[0]?.m ?? 0;
  const since = input.since ?? null;

  const { rows } = await ctx.db.query<ChangeRow>(
    `SELECT c.id, c.type, c.summary, c.data, c.detected_at, w.id AS watch_id, w.label, w.source_url
       FROM watches w
       JOIN changes c ON ${WATCH_READS_RESOURCE}
      WHERE w.client_id = $1 AND w.deleted_at IS NULL
        AND ($2::uuid IS NULL OR w.id = $2)
        AND c.id > CASE WHEN $3::bigint IS NULL THEN w.cursor ELSE GREATEST(w.baseline, $3::bigint) END
        AND c.id <= $4
        AND ${WATCH_SEES_CHANGE}
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

  if (!input.peek) await advanceCursor(ctx, client, cursor, input.watch_id);

  return {
    changes: kept.map((r) => ({
      id: r.id,
      watch_id: r.watch_id,
      watch_label: r.label,
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

async function advanceCursor(ctx: Ctx, client: Client, cursor: number, watchId?: string) {
  await ctx.db.query(
    `UPDATE watches SET cursor = GREATEST(cursor, $3) WHERE client_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2)`,
    [client.id, watchId ?? null, cursor],
  );
}

/**
 * Explicit acknowledgement for at-least-once processing: read with peek=true,
 * process, then ack the returned cursor. A crash before the ack means the same
 * changes are returned again.
 */
export async function ackChanges(ctx: Ctx, client: Client, input: { cursor: number; watch_id?: string }) {
  if (input.watch_id) await getWatch(ctx, client, input.watch_id, { includeCurrent: false });
  const { rows } = await ctx.db.query<{ m: number | null }>('SELECT max(id) AS m FROM changes');
  const cursor = Math.min(input.cursor, rows[0]?.m ?? 0);
  await advanceCursor(ctx, client, cursor, input.watch_id);
  return { acknowledged: true, cursor };
}
