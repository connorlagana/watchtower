import { describe, expect, it } from 'vitest';
import { computeChanges, diffLines, hashes } from '../src/extract/diff.js';
import type { Extraction, JobItem } from '../src/extract/types.js';

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

describe('hashes', () => {
  it('is independent of item order', () => {
    const a = hashes(x({ jobs: [job('1', 'A'), job('2', 'B')] }));
    const b = hashes(x({ jobs: [job('2', 'B'), job('1', 'A')] }));
    expect(a.contentHash).toBe(b.contentHash);
  });
});
