import { describe, expect, it } from 'vitest';
import { computeChanges as computeFull, diffLines, hashes, wordDiff } from '../src/extract/diff.js';
import type { Extraction, JobItem } from '../src/extract/types.js';

const computeChanges = (...args: Parameters<typeof computeFull>) => computeFull(...args).changes;
const job = (id: string, title: string, location = 'Remote'): JobItem => ({ key: `job:${id}`, title, location, source: 'jsonld' });
const x = (over: Partial<Extraction> = {}): Extraction => ({ title: 'T', text: 'a\nb', jobs: [], events: [], ...over });

describe('diffLines', () => {
  it('reports added and removed lines and ignores reordering', () => {
    expect(diffLines('a\nb\nc', 'c\na\nd')).toEqual({ added: ['d'], removed: ['b'] });
    expect(diffLines('a\nb', 'b\na')).toEqual({ added: [], removed: [] });
    expect(diffLines('a\na', 'a')).toEqual({ added: [], removed: ['a'] });
  });
});

describe('computeChanges', () => {
  it('treats the first snapshot as a baseline', () => {
    expect(computeChanges(null, x())).toEqual([]);
  });

  it('emits nothing when content is identical or only reordered', () => {
    expect(computeChanges(x(), x())).toEqual([]);
    expect(computeChanges(x({ text: 'a\nb' }), x({ text: 'b\na' }))).toEqual([]);
  });

  it('emits CONTENT_CHANGED with the changed lines', () => {
    const [c] = computeChanges(x({ text: 'Price: $10\nFooter' }), x({ text: 'Price: $12\nFooter' }));
    expect(c).toMatchObject({ type: 'CONTENT_CHANGED', data: { added: ['Price: $12'], removed: ['Price: $10'], lines_added: 1, lines_removed: 1 } });
    expect(c!.search_text).toContain('price: $12');
    expect(c!.data.details).toEqual([{ kind: 'modified', before: 'Price: $10', after: 'Price: $12', diff: 'Price: [-$10-]{+$12+}', context_after: 'Footer' }]);
    expect(c!.summary).toBe('Content changed: +1/-1 lines — "Price: [-$10-]{+$12+}"');
  });

  it('emits JOB_ADDED / JOB_REMOVED / JOB_UPDATED keyed by job identity', () => {
    const before = x({ jobs: [job('1', 'Backend'), job('2', 'Designer')] });
    const after = x({ jobs: [job('1', 'Backend', 'Berlin'), job('3', 'Senior iOS Engineer')] });
    const changes = computeChanges(before, after);
    expect(changes.map((c) => [c.type, c.item_key])).toEqual([
      ['JOB_ADDED', 'job:3'],
      ['JOB_REMOVED', 'job:2'],
      ['JOB_UPDATED', 'job:1'],
    ]);
    expect(changes[0]!.summary).toBe('New job: Senior iOS Engineer (Remote)');
    expect(changes[2]!.data.changed_fields).toEqual(['location']);
  });

  it('suppresses noise lines and reports what was suppressed', () => {
    const r = computeFull(x({ text: 'Views: 10\nPrice: $10' }), x({ text: 'Views: 11\nPrice: $12' }), { isNoise: (l) => l.startsWith('Views') });
    expect(r.changedLines.sort()).toEqual(['Price: $10', 'Price: $12', 'Views: 10', 'Views: 11']);
    expect(r.suppressedLines).toBe(2);
    expect(r.changes[0]!.data).toMatchObject({ added: ['Price: $12'], removed: ['Price: $10'], suppressed_noise_lines: 2 });
    const onlyNoise = computeFull(x({ text: 'Views: 10' }), x({ text: 'Views: 11' }), { isNoise: () => true });
    expect(onlyNoise.changes).toEqual([]);
  });

  it('pairs a JSON-LD job whose location changed into JOB_UPDATED instead of remove+add', () => {
    const before = x({ jobs: [{ key: 'job:ios|nyc', title: 'iOS Engineer', location: 'NYC', source: 'jsonld' }] });
    const after = x({ jobs: [{ key: 'job:ios|remote', title: 'iOS Engineer', location: 'Remote', source: 'jsonld' }] });
    const changes = computeChanges(before, after);
    expect(changes).toEqual([expect.objectContaining({ type: 'JOB_UPDATED', data: expect.objectContaining({ changed_fields: ['location'] }) })]);
  });

  it('reports a moved event as EVENT_RESCHEDULED', () => {
    const e = (d: string) => ({ key: `event:conf|${d}`, name: 'Conf', start_date: d, url: 'https://c.test/', source: 'jsonld' as const });
    const changes = computeChanges(x({ events: [e('2030-05-01')] }), x({ events: [e('2030-06-01')] }));
    expect(changes).toEqual([expect.objectContaining({ type: 'EVENT_RESCHEDULED', summary: 'Event rescheduled: Conf from 2030-05-01 to 2030-06-01' })]);
  });

  it('only trusts text-derived dates in the future, so dates passing out of view are not "removed"', () => {
    const now = new Date('2030-01-10T00:00:00Z');
    const d = (date: string) => ({ key: `date:${date}`, name: date, start_date: date, source: 'text' as const });
    // Today's date in a page header appears: not an event.
    expect(computeChanges(x({ events: [] }), x({ events: [d('2030-01-10')] }), { now })).toEqual([]);
    // A past date disappears: not a removal.
    expect(computeChanges(x({ events: [d('2030-01-05'), d('2030-03-01')] }), x({ events: [d('2030-03-01')] }), { now })).toEqual([]);
    // A future date appears: EVENT_ADDED.
    expect(computeChanges(x({ events: [d('2030-03-01')] }), x({ events: [d('2030-03-01'), d('2030-04-01')] }), { now }).map((c) => c.type)).toEqual(['EVENT_ADDED']);
  });

  it('reports ITEM_ADDED for new feed entries and ignores entries falling off the end', () => {
    const item = (k: string) => ({ key: `item:${k}`, title: `Post ${k}` });
    const before = x({ isFeed: true, items: [item('1'), item('2')], text: 'Post 1\nPost 2' });
    const after = x({ isFeed: true, items: [item('2'), item('3')], text: 'Post 2\nPost 3' });
    expect(computeChanges(before, after).map((c) => [c.type, c.summary])).toEqual([['ITEM_ADDED', 'New item: Post 3']]);
  });

  it('emits EVENT_ADDED for a new date', () => {
    const e = (d: string) => ({ key: `event:conf|${d}`, name: 'Conf', start_date: d, source: 'jsonld' as const });
    const changes = computeChanges(x({ events: [e('2026-05-01')] }), x({ events: [e('2026-05-01'), e('2026-09-01')] }));
    expect(changes).toEqual([expect.objectContaining({ type: 'EVENT_ADDED', summary: 'New event date: Conf on 2026-09-01' })]);
  });

  it('does not flood when a page switches between text dates and JSON-LD events', () => {
    const textDate = { key: 'date:2026-05-01', name: 'May 1', start_date: '2026-05-01', source: 'text' as const };
    const ld = { key: 'event:conf|2026-05-01', name: 'Conf', start_date: '2026-05-01', source: 'jsonld' as const };
    expect(computeChanges(x({ events: [textDate] }), x({ events: [ld] }))).toEqual([]);
  });
});

describe('wordDiff', () => {
  it('marks only the changed words', () => {
    expect(wordDiff('Tickets from $49 on sale now', 'Tickets from $59 on sale now')).toBe('Tickets from [-$49-]{+$59+} on sale now');
    expect(wordDiff('a b c', 'a b c d')).toBe('a b c {+d+}');
  });
});

describe('hashes', () => {
  it('is independent of item order', () => {
    const a = hashes(x({ jobs: [job('1', 'A'), job('2', 'B')] }));
    const b = hashes(x({ jobs: [job('2', 'B'), job('1', 'A')] }));
    expect(a.contentHash).toBe(b.contentHash);
  });
});
