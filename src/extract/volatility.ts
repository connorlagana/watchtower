/**
 * Learned per-resource line volatility.
 *
 * A line "signature" is its shape with digits and calendar words masked, so
 * "1,204 views" and "1,219 views" or "Updated Tue Sep 29" and "Updated Wed
 * Sep 30" share a signature. For each resource we count how many checks were
 * observed and how often each signature changed. Signatures that change on at
 * least half of all checks are noise (counters, clocks, rotating widgets) and
 * are suppressed from CONTENT_CHANGED. A price that changes once a week on an
 * hourly watch changes on <1% of checks and is always reported.
 *
 * Lines that differ between two back-to-back fetches (see the checker's
 * confirmation fetch) are marked volatile immediately.
 */
import { createHash } from 'node:crypto';

export interface LineStats {
  observed: number;
  sigs: Record<string, number>;
}

export const MIN_OBSERVATIONS = 4;
export const VOLATILE_RATE = 0.5;
/** Weight given to a line seen flipping between two back-to-back fetches. */
export const FLAKY_WEIGHT = MIN_OBSERVATIONS;
const MAX_SIGS = 3000;
const DECAY_AT = 500;

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/g;
const DAYS = /\b(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?|today|yesterday|tomorrow)\b/g;

export function lineSignature(line: string): string {
  const shape = line.toLowerCase().replace(MONTHS, 'M').replace(DAYS, 'D').replace(/\d+([.,:]\d+)*/g, '#').replace(/\s+/g, ' ');
  return createHash('sha1').update(shape).digest('base64url').slice(0, 12);
}

export function emptyStats(): LineStats {
  return { observed: 0, sigs: {} };
}

export function normalizeStats(raw: unknown): LineStats {
  const r = raw as Partial<LineStats> | null;
  return { observed: typeof r?.observed === 'number' ? r.observed : 0, sigs: r?.sigs && typeof r.sigs === 'object' ? { ...r.sigs } : {} };
}

export function isVolatile(stats: LineStats, line: string): boolean {
  const count = stats.sigs[lineSignature(line)] ?? 0;
  if (count === 0) return false;
  const enoughEvidence = stats.observed >= MIN_OBSERVATIONS || count >= FLAKY_WEIGHT;
  return enoughEvidence && count / Math.max(stats.observed, 1) >= VOLATILE_RATE;
}

/** Record one observed check: which lines changed, and which were seen flipping between two fetches. */
export function recordObservation(stats: LineStats, changedLines: string[], flakyLines: string[] = []): LineStats {
  const next: LineStats = { observed: stats.observed + 1, sigs: { ...stats.sigs } };
  for (const sig of new Set(changedLines.map(lineSignature))) next.sigs[sig] = (next.sigs[sig] ?? 0) + 1;
  for (const sig of new Set(flakyLines.map(lineSignature))) next.sigs[sig] = Math.max(next.sigs[sig] ?? 0, next.observed, FLAKY_WEIGHT);

  // Keep the table bounded and let old behaviour fade: halve everything periodically.
  if (next.observed >= DECAY_AT) {
    next.observed = Math.ceil(next.observed / 2);
    for (const k of Object.keys(next.sigs)) {
      const v = Math.floor(next.sigs[k]! / 2);
      if (v > 0) next.sigs[k] = v;
      else delete next.sigs[k];
    }
  }
  const keys = Object.keys(next.sigs);
  if (keys.length > MAX_SIGS) {
    keys.sort((a, b) => next.sigs[a]! - next.sigs[b]!);
    for (const k of keys.slice(0, keys.length - MAX_SIGS)) delete next.sigs[k];
  }
  return next;
}
