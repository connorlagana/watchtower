import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { FetchOptions } from '../fetch/safeFetch.js';
import type { ConditionEvaluator } from './conditions.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Ctx {
  db: Db;
  config: Config;
  log: Logger;
  /** Null when no LLM is configured; natural-language conditions are then unavailable. */
  conditions: ConditionEvaluator | null;
}

/**
 * SQL predicate: change `c` is visible to watch `w` (type, keyword and, for
 * watches with a condition, a positive LLM verdict).
 */
export const WATCH_SEES_CHANGE = `
  c.type = ANY(w.change_types)
  AND (cardinality(w.keywords) = 0 OR EXISTS (SELECT 1 FROM unnest(w.keywords) k WHERE position(k IN c.search_text) > 0))
  AND (w.condition IS NULL OR EXISTS (
    SELECT 1 FROM watch_change_verdicts v WHERE v.watch_id = w.id AND v.change_id = c.id AND v.match))`;

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
