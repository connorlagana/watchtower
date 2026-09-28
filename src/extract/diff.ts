/**
 * Turn two extractions into typed change events.
 * Pure functions: no I/O, easy to test.
 */
import { createHash } from 'node:crypto';
import type { EventItem, Extraction, JobItem } from './types.js';

export type ChangeType =
  | 'CONTENT_CHANGED'
  | 'JOB_ADDED'
  | 'JOB_REMOVED'
  | 'JOB_UPDATED'
  | 'EVENT_ADDED'
  | 'EVENT_REMOVED'
  | 'EVENT_UPDATED';

export const CHANGE_TYPES_BY_KIND: Record<'url' | 'jobs' | 'events', ChangeType[]> = {
  url: ['CONTENT_CHANGED'],
  jobs: ['JOB_ADDED', 'JOB_REMOVED', 'JOB_UPDATED'],
  events: ['EVENT_ADDED', 'EVENT_REMOVED', 'EVENT_UPDATED'],
};

export interface ChangeDraft {
  type: ChangeType;
  item_key: string | null;
  summary: string;
  data: Record<string, unknown>;
  search_text: string;
}

const MAX_LINES_REPORTED = 50;
const MAX_ITEM_CHANGES = 200;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashes(x: Extraction): { textHash: string; contentHash: string } {
  const textHash = sha256(x.text);
  const structured = JSON.stringify({
    jobs: [...x.jobs].sort((a, b) => a.key.localeCompare(b.key)),
    events: [...x.events].sort((a, b) => a.key.localeCompare(b.key)),
  });
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

const jobLabel = (j: JobItem) => `${j.title}${j.location ? ` (${j.location})` : ''}`;
const jobSearch = (j: JobItem) => [j.title, j.location, j.department, j.company].filter(Boolean).join(' ').toLowerCase();
const eventLabel = (e: EventItem) =>
  `${e.source === 'text' ? `date ${e.start_date}` : e.name}${e.source !== 'text' && e.start_date ? ` on ${e.start_date}` : ''}${e.location ? ` @ ${e.location}` : ''}`;
const eventSearch = (e: EventItem) => [e.name, e.start_date, e.location].filter(Boolean).join(' ').toLowerCase();

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function computeChanges(before: Extraction | null, after: Extraction): ChangeDraft[] {
  if (!before) return []; // first snapshot is a baseline, not a change
  const out: ChangeDraft[] = [];

  if (before.text !== after.text) {
    const { added, removed } = diffLines(before.text, after.text);
    if (added.length || removed.length) {
      const first = added[0] ?? removed[0] ?? '';
      out.push({
        type: 'CONTENT_CHANGED',
        item_key: null,
        summary: `Content changed: +${added.length}/-${removed.length} lines${first ? ` — "${clip(first, 100)}"` : ''}`,
        data: {
          title: after.title,
          lines_added: added.length,
          lines_removed: removed.length,
          added: added.slice(0, MAX_LINES_REPORTED),
          removed: removed.slice(0, MAX_LINES_REPORTED),
          truncated: added.length > MAX_LINES_REPORTED || removed.length > MAX_LINES_REPORTED,
        },
        search_text: [...added, ...removed].join('\n').toLowerCase().slice(0, 20_000),
      });
    }
  }

  const jobs = diffItems(before.jobs, after.jobs, ['title', 'location', 'department', 'url']);
  for (const j of jobs.added) out.push({ type: 'JOB_ADDED', item_key: j.key, summary: `New job: ${jobLabel(j)}`, data: { job: j }, search_text: jobSearch(j) });
  for (const j of jobs.removed) out.push({ type: 'JOB_REMOVED', item_key: j.key, summary: `Job removed: ${jobLabel(j)}`, data: { job: j }, search_text: jobSearch(j) });
  for (const u of jobs.updated)
    out.push({
      type: 'JOB_UPDATED',
      item_key: u.after.key,
      summary: `Job updated: ${jobLabel(u.after)} (${u.changed_fields.join(', ')})`,
      data: { job: u.after, before: u.before, changed_fields: u.changed_fields },
      search_text: jobSearch(u.after),
    });

  // Text-derived dates are only comparable with text-derived dates (and JSON-LD with JSON-LD);
  // if a page switches between the two we'd otherwise report every date as new.
  const sameEventSource = (before.events[0]?.source ?? after.events[0]?.source) === (after.events[0]?.source ?? before.events[0]?.source);
  if (sameEventSource) {
    const events = diffItems(before.events, after.events, ['name', 'end_date', 'location', 'url', 'status']);
    for (const e of events.added)
      out.push({ type: 'EVENT_ADDED', item_key: e.key, summary: `New event date: ${eventLabel(e)}`, data: { event: e }, search_text: eventSearch(e) });
    for (const e of events.removed)
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
  return [...content, ...items];
}
