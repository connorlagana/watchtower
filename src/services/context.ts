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

/**
 * SQL predicate: change `c` is visible to watch `w` (change type and job filters).
 * Mirrors jobMatches() in watches.ts, which applies the same filters to current jobs.
 */
export const WATCH_SEES_CHANGE = `
  c.type = ANY(w.change_types)
  AND (cardinality(w.keywords) = 0 OR EXISTS (SELECT 1 FROM unnest(w.keywords) k WHERE position(k IN c.search_text) > 0))
  AND NOT EXISTS (SELECT 1 FROM unnest(w.exclude_keywords) k WHERE position(k IN c.search_text) > 0)
  AND (NOT w.remote_only OR (c.data #>> '{job,remote}') = 'true')
  AND (cardinality(w.locations) = 0 OR EXISTS (SELECT 1 FROM unnest(w.locations) l WHERE position(l IN lower(coalesce(c.data #>> '{job,location}', ''))) > 0))
  AND (cardinality(w.seniority) = 0 OR (c.data #>> '{job,seniority}') = ANY(w.seniority))`;

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
