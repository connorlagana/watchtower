import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { FetchOptions } from '../fetch/safeFetch.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Ctx {
  db: Db;
  config: Config;
  log: Logger;
}

/** SQL for the text keyword filters match against, for a job held in the jsonb expression `job`. Mirrors jobSearch() in diff.ts. */
export const jobTextSql = (job: string) =>
  `lower(concat_ws(' ', nullif(${job} ->> 'title', ''), nullif(${job} ->> 'location', ''), nullif(${job} ->> 'department', ''), nullif(${job} ->> 'company', '')))`;

/**
 * SQL predicate: the job in jsonb expression `job`, whose keyword text is `text`,
 * passes the filters of watch `w`. Mirrors jobMatches() in watches.ts.
 *
 * Salary: the top of the stated range (converted to a yearly figure) must reach
 * min_salary. Experience: the years asked for must not exceed max_experience_years.
 * A posting that states neither passes only while the watch has include_unknown.
 */
export const jobFilterSql = (job: string, text: string) => `
  (cardinality(w.keywords) = 0 OR EXISTS (SELECT 1 FROM unnest(w.keywords) k WHERE wt_term_match(${text}, k)))
  AND NOT EXISTS (SELECT 1 FROM unnest(w.all_keywords) k WHERE NOT wt_term_match(${text}, k))
  AND NOT EXISTS (SELECT 1 FROM unnest(w.exclude_keywords) k WHERE wt_term_match(${text}, k))
  AND (NOT w.remote_only OR (${job} ->> 'remote') = 'true')
  AND (cardinality(w.locations) = 0 OR EXISTS (
        SELECT 1 FROM unnest(w.locations) l
         WHERE wt_term_match(lower(concat_ws(' ', ${job} ->> 'location', ${job} ->> 'other_locations')), l)))
  AND (cardinality(w.seniority) = 0 OR (${job} ->> 'seniority') = ANY(w.seniority))
  AND (w.min_salary IS NULL OR CASE
        WHEN coalesce(${job} #>> '{salary,annual_max}', ${job} #>> '{salary,annual_min}') IS NULL THEN w.include_unknown
        ELSE coalesce(${job} #>> '{salary,annual_max}', ${job} #>> '{salary,annual_min}')::numeric >= w.min_salary
             AND (w.salary_currency IS NULL OR coalesce(${job} #>> '{salary,currency}', w.salary_currency) = w.salary_currency)
       END)
  AND (w.max_experience_years IS NULL OR CASE
        WHEN (${job} ->> 'experience_years') IS NULL THEN w.include_unknown
        ELSE (${job} ->> 'experience_years')::numeric <= w.max_experience_years
       END)`;

/** SQL predicate: change `c` is visible to watch `w` (change type and job filters). */
export const WATCH_SEES_CHANGE = `
  c.type = ANY(w.change_types)
  AND ${jobFilterSql("(c.data -> 'job')", 'c.search_text')}`;

/** SQL predicate: watch `w` reads the changes of resource-bearing row `c`. A search watch (no resource) reads every board. */
export const WATCH_READS_RESOURCE = `(w.resource_id IS NULL OR c.resource_id = w.resource_id)`;

/** SQL predicate: resource `r` is being monitored: it is in the directory or someone watches it. */
export const RESOURCE_IS_MONITORED = `(r.indexed OR EXISTS (SELECT 1 FROM watches aw WHERE aw.resource_id = r.id AND aw.deleted_at IS NULL))`;

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function fetchOptions(config: Config): FetchOptions {
  return {
    policy: { allowPrivateNetworks: config.allowPrivateNetworks, allowedPorts: config.allowedPorts },
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.maxBodyBytes,
    maxRedirects: config.maxRedirects,
    userAgent: config.userAgent,
  };
}
