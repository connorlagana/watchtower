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

/** SQL predicate: change `c` is visible to watch `w` (change type and keyword filters). */
export const WATCH_SEES_CHANGE = `
  c.type = ANY(w.change_types)
  AND (cardinality(w.keywords) = 0 OR EXISTS (SELECT 1 FROM unnest(w.keywords) k WHERE position(k IN c.search_text) > 0))`;

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
