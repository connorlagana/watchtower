/**
 * Turn two extractions into typed job change events.
 * Pure functions: no I/O, easy to test.
 */
import { createHash } from 'node:crypto';
import type { Extraction, JobItem } from './types.js';

export type ChangeType = 'JOB_ADDED' | 'JOB_REMOVED' | 'JOB_UPDATED';

export const JOB_CHANGE_TYPES: ChangeType[] = ['JOB_ADDED', 'JOB_REMOVED', 'JOB_UPDATED'];

export interface ChangeDraft {
  type: ChangeType;
  item_key: string | null;
  summary: string;
  data: Record<string, unknown>;
  search_text: string;
}

const MAX_ITEM_CHANGES = 200;
const JOB_FIELDS = ['title', 'location', 'department', 'url'] as const;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Hash of the job set, independent of the order the source lists jobs in. */
export function contentHash(x: Extraction): string {
  return sha256(JSON.stringify([...x.jobs].sort((p, q) => p.key.localeCompare(q.key))));
}

/** A partial entry (iCIMS sitemap only) becoming a full one is new information, not an edit. */
const isEnrichment = (b: JobItem, a: JobItem) => b.partial === true && !a.partial;

function diffItems<T extends { key: string }>(before: T[], after: T[], fields: readonly (keyof T)[]) {
  const prev = new Map(before.map((i) => [i.key, i]));
  const next = new Map(after.map((i) => [i.key, i]));
  const added = after.filter((i) => !prev.has(i.key));
  const removed = before.filter((i) => !next.has(i.key));
  const updated: { before: T; after: T; changed_fields: string[] }[] = [];
  for (const a of after) {
    const b = prev.get(a.key);
    if (!b) continue;
    const changed = fields.filter((f) => (b[f] ?? null) !== (a[f] ?? null)).map(String);
    if (changed.length) updated.push({ before: b, after: a, changed_fields: changed });
  }
  return { added, removed, updated };
}

/**
 * Pair removed/added items that are really one item whose identity-bearing
 * field changed (a JSON-LD job without an id whose location changed). Only
 * unique matches are paired.
 */
function pairUnique<T>(removed: T[], added: T[], match: (r: T, a: T) => boolean): [T, T][] {
  const pairs: [T, T][] = [];
  for (const r of removed) {
    const candidates = added.filter((a) => match(r, a));
    if (candidates.length !== 1) continue;
    const a = candidates[0]!;
    if (removed.filter((r2) => match(r2, a)).length !== 1) continue;
    pairs.push([r, a]);
  }
  return pairs;
}

const lc = (s?: string) => (s ?? '').toLowerCase().trim();

const jobLabel = (j: JobItem) => `${j.title}${j.location ? ` (${j.location})` : ''}`;
export const jobSearch = (j: JobItem) => [j.title, j.location, j.department, j.company].filter(Boolean).join(' ').toLowerCase();

export function computeChanges(before: Extraction | null, after: Extraction): ChangeDraft[] {
  if (!before) return []; // first snapshot is a baseline, not a change
  const out: ChangeDraft[] = [];

  const jobs = diffItems(before.jobs, after.jobs, JOB_FIELDS);
  const jobPairs = pairUnique(
    jobs.removed.filter((j) => j.source === 'jsonld'),
    jobs.added.filter((j) => j.source === 'jsonld'),
    (r, a) => lc(r.title) === lc(a.title) && lc(r.company) === lc(a.company),
  );
  const pairedJobs = new Set(jobPairs.flat());
  for (const [b, a] of jobPairs) {
    const changed = JOB_FIELDS.filter((f) => (b[f] ?? null) !== (a[f] ?? null));
    jobs.updated.push({ before: b, after: a, changed_fields: changed });
  }
  for (const j of jobs.added.filter((x) => !pairedJobs.has(x)))
    out.push({ type: 'JOB_ADDED', item_key: j.key, summary: `New job: ${jobLabel(j)}`, data: { job: j }, search_text: jobSearch(j) });
  // A source that only shows its newest postings cannot tell us a job was taken down.
  if (after.complete !== false)
    for (const j of jobs.removed.filter((x) => !pairedJobs.has(x)))
      out.push({ type: 'JOB_REMOVED', item_key: j.key, summary: `Job removed: ${jobLabel(j)}`, data: { job: j }, search_text: jobSearch(j) });
  for (const u of jobs.updated.filter((u) => !isEnrichment(u.before, u.after)))
    out.push({
      type: 'JOB_UPDATED',
      item_key: u.after.key,
      summary: `Job updated: ${jobLabel(u.after)} (${u.changed_fields.join(', ')})`,
      data: { job: u.after, before: u.before, changed_fields: u.changed_fields },
      search_text: jobSearch(u.after),
    });

  return out.slice(0, MAX_ITEM_CHANGES);
}
