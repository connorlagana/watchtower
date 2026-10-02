/**
 * The board directory: job boards Watchtower monitors on its own, so a search
 * watch (filters, no URL) has postings to match from the first minute.
 *
 * A directory board is an ordinary resource with `indexed = true`. The
 * scheduler checks it like any watched board, its changes land in the same
 * `changes` table, and search watches read those. The directory comes from the
 * built-in list (src/search/boards.ts) plus an optional operator file, and it
 * grows as clients watch boards by URL (promoteToDirectory).
 */
import { readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import { resolveSource } from '../extract/adapters.js';
import { PLATFORM_ADAPTERS } from '../extract/types.js';
import { BOARDS } from '../search/boards.js';
import { validateUrl } from '../security/ssrf.js';
import type { Ctx } from './context.js';

/** Board URLs to monitor: the built-in directory plus INDEX_BOARDS_FILE (one URL per line, # comments). */
export async function loadBoardUrls(config: Config): Promise<string[]> {
  if (!config.indexEnabled) return [];
  const urls = [...BOARDS];
  if (config.indexBoardsFile) {
    const text = await readFile(config.indexBoardsFile, 'utf8');
    for (const line of text.split('\n')) {
      const url = line.replace(/#.*$/, '').trim();
      if (url) urls.push(url);
    }
  }
  return urls;
}

export interface IndexSyncReport {
  indexed: number;
  added: number;
  removed: number;
  invalid: string[];
}

/**
 * Make the listed part of the directory exactly `urls`: new boards become
 * resources due for their first check, boards no longer listed leave the
 * directory (and are cleaned up by maintenance unless someone watches them).
 * Boards that clients added by watching them are left alone, unless the
 * directory is switched off. Safe to run on every start and from every replica.
 */
export async function syncBoardIndex(ctx: Ctx, urls: string[]): Promise<IndexSyncReport> {
  const policy = { allowPrivateNetworks: ctx.config.allowPrivateNetworks, allowedPorts: ctx.config.allowedPorts };
  const boards = new Map<string, { url: string; host: string; adapter: string }>();
  const invalid: string[] = [];
  for (const raw of urls) {
    try {
      const source = resolveSource(validateUrl(raw, policy).toString());
      const host = new URL(source.fetchUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      boards.set(`${source.adapter} ${source.fetchUrl}`, { url: source.fetchUrl, host, adapter: source.adapter });
    } catch {
      invalid.push(raw);
    }
  }
  const list = [...boards.values()];
  const { rows } = await ctx.db.query<{ added: number; removed: number }>(
    `WITH wanted AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS t(url, host, adapter)
     ), upserted AS (
       INSERT INTO resources (url, host, selector, adapter, indexed, index_origin)
       SELECT url, host, '', adapter, true, 'directory' FROM wanted
       ON CONFLICT (url, selector, adapter) DO UPDATE SET indexed = true, index_origin = 'directory'
       RETURNING (xmax = 0) AS inserted
     ), dropped AS (
       UPDATE resources r SET indexed = false, index_origin = NULL
        WHERE r.indexed AND (r.index_origin = 'directory' OR NOT $4)
          AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.url = r.url AND w.adapter = r.adapter AND r.selector = '')
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM upserted WHERE inserted)::int AS added, (SELECT count(*) FROM dropped)::int AS removed`,
    [list.map((b) => b.url), list.map((b) => b.host), list.map((b) => b.adapter), ctx.config.indexEnabled],
  );
  const report = { indexed: list.length, added: rows[0]?.added ?? 0, removed: rows[0]?.removed ?? 0, invalid };
  if (invalid.length) ctx.log.warn({ invalid }, 'board directory: skipped URLs that are not valid public board URLs');
  ctx.log.info({ indexed: report.indexed, added: report.added, removed: report.removed }, 'board directory synced');
  return report;
}

/**
 * Keep a board that a client watched by URL in the directory, so every search
 * watch covers it from now on, even after that client's watch ends.
 *
 * Only job-board platform boards with open jobs qualify (an arbitrary careers
 * page is one site's traffic, not a shared listing API), and at most
 * INDEX_MAX_PROMOTED of them are kept; maintenance drops the ones that stop
 * answering. Returns whether the board was added.
 */
export async function promoteToDirectory(ctx: Ctx, resourceId: string): Promise<boolean> {
  if (!ctx.config.indexEnabled || ctx.config.indexMaxPromoted <= 0) return false;
  const { rowCount } = await ctx.db.query(
    `UPDATE resources r SET indexed = true, index_origin = 'watched'
      WHERE r.id = $1 AND NOT r.indexed AND r.adapter = ANY($2) AND r.last_error IS NULL
        AND coalesce(jsonb_array_length((SELECT s.structured -> 'jobs' FROM snapshots s WHERE s.id = r.current_snapshot_id)), 0) > 0
        AND (SELECT count(*) FROM resources x WHERE x.indexed AND x.index_origin = 'watched') < $3`,
    [resourceId, [...PLATFORM_ADAPTERS], ctx.config.indexMaxPromoted],
  );
  if (rowCount) ctx.log.info({ resource: resourceId }, 'board added to the directory by a watch');
  return (rowCount ?? 0) > 0;
}

/** Client-added boards that have failed this many checks in a row (about a week, with backoff) leave the directory. */
export const PROMOTED_MAX_FAILURES = 8;
