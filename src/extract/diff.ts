/**
 * Turn two extractions into typed change events.
 * Pure functions: no I/O, easy to test.
 */
import { createHash } from 'node:crypto';
import type { EventItem, Extraction, FeedItem, JobItem } from './types.js';
import { lineSignature } from './volatility.js';

export type ChangeType =
  | 'CONTENT_CHANGED'
  | 'ITEM_ADDED'
  | 'JOB_ADDED'
  | 'JOB_REMOVED'
  | 'JOB_UPDATED'
  | 'EVENT_ADDED'
  | 'EVENT_REMOVED'
  | 'EVENT_UPDATED'
  | 'EVENT_RESCHEDULED';

export const CHANGE_TYPES_BY_KIND: Record<'url' | 'jobs' | 'events', ChangeType[]> = {
  url: ['CONTENT_CHANGED', 'ITEM_ADDED'],
  jobs: ['JOB_ADDED', 'JOB_REMOVED', 'JOB_UPDATED'],
  events: ['EVENT_ADDED', 'EVENT_REMOVED', 'EVENT_UPDATED', 'EVENT_RESCHEDULED'],
};

export interface ChangeDraft {
  type: ChangeType;
  item_key: string | null;
  summary: string;
  data: Record<string, unknown>;
  search_text: string;
}

export interface DiffOptions {
  /** Lines to leave out of CONTENT_CHANGED (learned noise, lines that flipped between two fetches). */
  isNoise?: (line: string) => boolean;
  /** "Now", for the text-date window. */
  now?: Date;
}

export interface DiffResult {
  changes: ChangeDraft[];
  /** Every added/removed line before noise filtering (feeds volatility learning). */
  changedLines: string[];
  suppressedLines: number;
}

const MAX_LINES_REPORTED = 50;
const MAX_ITEM_CHANGES = 200;
/** Text-derived dates are only trusted from this far ahead ("today" in a page header is not an event). */
const TEXT_DATE_MIN_DAYS_AHEAD = 2;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashes(x: Extraction): { textHash: string; contentHash: string } {
  const textHash = sha256(x.text);
  const byKey = <T extends { key: string }>(a: T[] = []) => [...a].sort((p, q) => p.key.localeCompare(q.key));
  const structured = JSON.stringify({ jobs: byKey(x.jobs), events: byKey(x.events), items: byKey(x.items) });
  return { textHash, contentHash: sha256(`${textHash}\n${structured}`) };
}

/** Multiset line diff. Order-only changes are deliberately ignored. */
export function diffLines(before: string, after: string): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const l of before ? before.split('\n') : []) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after ? after.split('\n') : []) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, c] of count) for (let i = 0; i < c; i++) removed.push(l);
  return { added, removed };
}

// ---------------------------------------------------------------- word diffs

const tokenize = (s: string) => s.split(/(\s+)/).filter(Boolean);

/** Word-level diff rendered as `[-removed-]{+added+}`; null if the lines are too long to diff cheaply. */
export function wordDiff(before: string, after: string): string | null {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > 40_000) return null;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let del = '';
  let ins = '';
  const flush = () => {
    const lead = /^\s/.test(del || ins) && out.length > 0 && !/\s$/.test(out[out.length - 1]!);
    if (lead && (del.trim() || ins.trim())) out.push(' ');
    if (del.trim()) out.push(`[-${del.trim()}-]`);
    if (ins.trim()) out.push(`{+${ins.trim()}+}`);
    if (del.trim() || ins.trim()) out.push(' ');
    del = ins = '';
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      out.push(a[i]!);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ins += b[j++];
    else del += a[i++];
  }
  flush();
  return out.join('').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

type Detail =
  | { kind: 'modified'; before: string; after: string; diff: string | null; context_before?: string; context_after?: string }
  | { kind: 'added' | 'removed'; line: string; context_before?: string; context_after?: string };

function contextFor(lines: string[], line: string) {
  const i = lines.indexOf(line);
  if (i < 0) return {};
  return { context_before: lines[i - 1], context_after: lines[i + 1] };
}

/** Pair similar removed/added lines into "modified" entries and attach neighbouring lines as context. */
function describe(added: string[], removed: string[], beforeText: string, afterText: string): Detail[] {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');
  const unpairedAdded = new Set(added.map((_, i) => i));
  const details: Detail[] = [];
  for (const r of removed) {
    let best = -1;
    let bestScore = 0.4;
    const sig = lineSignature(r);
    for (const i of unpairedAdded) {
      // Same shape (only numbers/dates differ) is the strongest signal of an edited line.
      const score = lineSignature(added[i]!) === sig ? 1 : similarity(r, added[i]!);
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    if (best >= 0) {
      unpairedAdded.delete(best);
      details.push({ kind: 'modified', before: r, after: added[best]!, diff: wordDiff(r, added[best]!), ...contextFor(afterLines, added[best]!) });
    } else details.push({ kind: 'removed', line: r, ...contextFor(beforeLines, r) });
  }
  for (const i of unpairedAdded) details.push({ kind: 'added', line: added[i]!, ...contextFor(afterLines, added[i]!) });
  return details;
}

// ---------------------------------------------------------------- items

function diffItems<T extends { key: string }>(before: T[], after: T[], fields: (keyof T)[]) {
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
 * field changed (a JSON-LD job without an id whose location changed; an event
 * that moved to a new date). Only unique matches are paired.
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
const jobSearch = (j: JobItem) => [j.title, j.location, j.department, j.company].filter(Boolean).join(' ').toLowerCase();
const eventLabel = (e: EventItem) =>
  `${e.source === 'text' ? `date ${e.start_date}` : e.name}${e.source !== 'text' && e.start_date ? ` on ${e.start_date}` : ''}${e.location ? ` @ ${e.location}` : ''}`;
const eventSearch = (e: EventItem) => [e.name, e.start_date, e.location].filter(Boolean).join(' ').toLowerCase();
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Text-derived dates: only those comfortably in the future count as event dates. */
export function inTextDateWindow(e: EventItem, now = new Date()): boolean {
  if (e.source !== 'text') return true;
  if (!e.start_date) return false;
  const min = new Date(now.getTime() + TEXT_DATE_MIN_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);
  return e.start_date >= min;
}

export function computeChanges(before: Extraction | null, after: Extraction, opts: DiffOptions = {}): DiffResult {
  if (!before) return { changes: [], changedLines: [], suppressedLines: 0 }; // first snapshot is a baseline, not a change
  const out: ChangeDraft[] = [];
  const isNoise = opts.isNoise ?? (() => false);
  const now = opts.now ?? new Date();
  let changedLines: string[] = [];
  let suppressedLines = 0;

  // Feeds: new entries are the signal; entries falling off the end are not.
  if (after.isFeed) {
    const prevKeys = new Set((before.items ?? []).map((i) => i.key));
    for (const item of (after.items ?? []).filter((i) => !prevKeys.has(i.key)) as FeedItem[]) {
      out.push({
        type: 'ITEM_ADDED',
        item_key: item.key,
        summary: `New item: ${clip(item.title || item.url || '')}`,
        data: { item },
        search_text: [item.title, item.summary].filter(Boolean).join(' ').toLowerCase(),
      });
    }
  } else if (before.text !== after.text) {
    const raw = diffLines(before.text, after.text);
    changedLines = [...raw.added, ...raw.removed];
    const added = raw.added.filter((l) => !isNoise(l));
    const removed = raw.removed.filter((l) => !isNoise(l));
    suppressedLines = changedLines.length - added.length - removed.length;
    if (added.length || removed.length) {
      const details = describe(added, removed, before.text, after.text);
      const first = details[0];
      const headline = !first ? '' : first.kind === 'modified' ? (first.diff ?? `${first.before} → ${first.after}`) : first.line;
      out.push({
        type: 'CONTENT_CHANGED',
        item_key: null,
        summary: `Content changed: +${added.length}/-${removed.length} lines${headline ? ` — "${clip(headline, 100)}"` : ''}`,
        data: {
          title: after.title,
          lines_added: added.length,
          lines_removed: removed.length,
          added: added.slice(0, MAX_LINES_REPORTED),
          removed: removed.slice(0, MAX_LINES_REPORTED),
          details: details.slice(0, MAX_LINES_REPORTED),
          suppressed_noise_lines: suppressedLines,
          truncated: added.length > MAX_LINES_REPORTED || removed.length > MAX_LINES_REPORTED,
        },
        search_text: [...added, ...removed].join('\n').toLowerCase().slice(0, 20_000),
      });
    }
  }

  // Jobs.
  const jobs = diffItems(before.jobs, after.jobs, ['title', 'location', 'department', 'url']);
  const jobPairs = pairUnique(
    jobs.removed.filter((j) => j.source === 'jsonld'),
    jobs.added.filter((j) => j.source === 'jsonld'),
    (r, a) => lc(r.title) === lc(a.title) && lc(r.company) === lc(a.company),
  );
  const pairedJobs = new Set(jobPairs.flat());
  for (const [b, a] of jobPairs) {
    const changed = (['title', 'location', 'department', 'url'] as const).filter((f) => (b[f] ?? null) !== (a[f] ?? null));
    jobs.updated.push({ before: b, after: a, changed_fields: changed });
  }
  for (const j of jobs.added.filter((x) => !pairedJobs.has(x)))
    out.push({ type: 'JOB_ADDED', item_key: j.key, summary: `New job: ${jobLabel(j)}`, data: { job: j }, search_text: jobSearch(j) });
  for (const j of jobs.removed.filter((x) => !pairedJobs.has(x)))
    out.push({ type: 'JOB_REMOVED', item_key: j.key, summary: `Job removed: ${jobLabel(j)}`, data: { job: j }, search_text: jobSearch(j) });
  for (const u of jobs.updated)
    out.push({
      type: 'JOB_UPDATED',
      item_key: u.after.key,
      summary: `Job updated: ${jobLabel(u.after)} (${u.changed_fields.join(', ')})`,
      data: { job: u.after, before: u.before, changed_fields: u.changed_fields },
      search_text: jobSearch(u.after),
    });

  // Events. Text-derived dates are only comparable with text-derived dates (and JSON-LD with JSON-LD);
  // if a page switches between the two we'd otherwise report every date as new.
  const beforeEvents = before.events.filter((e) => inTextDateWindow(e, now));
  const afterEvents = after.events.filter((e) => inTextDateWindow(e, now));
  const src = (list: EventItem[]) => list[0]?.source;
  const sameEventSource = (src(before.events) ?? src(after.events)) === (src(after.events) ?? src(before.events));
  if (sameEventSource) {
    const events = diffItems(beforeEvents, afterEvents, ['name', 'end_date', 'location', 'url', 'status']);
    const moved = pairUnique(
      events.removed.filter((e) => e.source === 'jsonld'),
      events.added.filter((e) => e.source === 'jsonld'),
      (r, a) => lc(r.name) === lc(a.name) && lc(r.url) === lc(a.url) && lc(r.location) === lc(a.location) && r.start_date !== a.start_date,
    );
    const pairedEvents = new Set(moved.flat());
    for (const [b, a] of moved)
      out.push({
        type: 'EVENT_RESCHEDULED',
        item_key: a.key,
        summary: `Event rescheduled: ${a.name} from ${b.start_date ?? '?'} to ${a.start_date ?? '?'}`,
        data: { event: a, before: b, previous_start_date: b.start_date ?? null },
        search_text: eventSearch(a),
      });
    for (const e of events.added.filter((x) => !pairedEvents.has(x)))
      out.push({ type: 'EVENT_ADDED', item_key: e.key, summary: `New event date: ${eventLabel(e)}`, data: { event: e }, search_text: eventSearch(e) });
    for (const e of events.removed.filter((x) => !pairedEvents.has(x)))
      out.push({ type: 'EVENT_REMOVED', item_key: e.key, summary: `Event removed: ${eventLabel(e)}`, data: { event: e }, search_text: eventSearch(e) });
    for (const u of events.updated)
      out.push({
        type: 'EVENT_UPDATED',
        item_key: u.after.key,
        summary: `Event updated: ${eventLabel(u.after)} (${u.changed_fields.join(', ')})`,
        data: { event: u.after, before: u.before, changed_fields: u.changed_fields },
        search_text: eventSearch(u.after),
      });
  }

  const content = out.filter((c) => c.type === 'CONTENT_CHANGED');
  const items = out.filter((c) => c.type !== 'CONTENT_CHANGED').slice(0, MAX_ITEM_CHANGES);
  return { changes: [...content, ...items], changedLines, suppressedLines };
}
