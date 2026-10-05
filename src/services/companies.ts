/**
 * The published list of companies: every board in the directory (the
 * built-in list, the operator's file and boards promoted by being watched),
 * so people and agents can see what a search covers before relying on it.
 * Boards someone watches without them joining the directory are left out:
 * they say what that client is following.
 */
import { boardPageUrl, companyFromBoard } from '../extract/adapters.js';
import type { AdapterName } from '../extract/types.js';
import type { Ctx } from './context.js';

export interface Company {
  name: string;
  /** The board's public page; pass it to watch_jobs as url to follow only this company. */
  board_url: string;
  platform: AdapterName;
  /** Jobs open at the last check; null until the first check. */
  open_jobs: number | null;
  last_checked_at: Date | null;
}

export const MAX_COMPANIES_LIMIT = 1000;

/** Every company in the directory, by name. */
export async function loadCompanies(ctx: Ctx): Promise<Company[]> {
  const { rows } = await ctx.db.query<{ url: string; adapter: AdapterName; last_checked_at: Date | null; company: string | null; open_jobs: number | null }>(
    `SELECT r.url, r.adapter, r.last_checked_at,
            s.structured -> 'jobs' -> 0 ->> 'company' AS company,
            jsonb_array_length(s.structured -> 'jobs') AS open_jobs
       FROM resources r
       LEFT JOIN snapshots s ON s.id = r.current_snapshot_id
      WHERE r.indexed`,
  );
  return rows
    .map((r) => ({
      name: r.company?.trim() || companyFromBoard(r.adapter, r.url) || new URL(r.url).hostname,
      board_url: boardPageUrl(r.adapter, r.url),
      platform: r.adapter,
      open_jobs: r.open_jobs,
      last_checked_at: r.last_checked_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.board_url.localeCompare(b.board_url));
}

export interface ListCompaniesInput {
  /** Case-insensitive part of a company name or board URL. */
  query?: string;
  limit?: number;
  offset?: number;
}

export async function listCompanies(ctx: Ctx, input: ListCompaniesInput) {
  const all = await loadCompanies(ctx);
  const q = input.query?.trim().toLowerCase();
  const matching = q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.board_url.toLowerCase().includes(q)) : all;
  const limit = Math.min(Math.max(Math.round(input.limit ?? 100), 1), MAX_COMPANIES_LIMIT);
  const offset = Math.max(Math.round(input.offset ?? 0), 0);
  const companies = matching.slice(offset, offset + limit);
  const next = offset + companies.length;
  return {
    total: matching.length,
    directory_size: all.length,
    offset,
    next_offset: next < matching.length ? next : null,
    companies,
    page_url: `${ctx.config.publicBaseUrl}/companies`,
    note:
      'These are the boards every search (search_jobs, and watch_jobs without a url) covers. A company that is missing can be added by calling ' +
      'watch_jobs with its board URL or careers page; it then stays covered for everyone.',
  };
}
