import { describe, expect, it } from 'vitest';
import { computeChanges, contentHash } from '../src/extract/diff.js';
import type { Extraction, JobItem } from '../src/extract/types.js';

const job = (id: string, title: string, location = 'Remote'): JobItem => ({ key: `job:${id}`, title, location, source: 'jsonld' });
const x = (jobs: JobItem[] = []): Extraction => ({ jobs });

describe('computeChanges', () => {
  it('treats the first snapshot as a baseline', () => {
    expect(computeChanges(null, x([job('1', 'A')]))).toEqual([]);
  });

  it('emits nothing when the job set is identical or only reordered', () => {
    expect(computeChanges(x([job('1', 'A'), job('2', 'B')]), x([job('2', 'B'), job('1', 'A')]))).toEqual([]);
  });

  it('emits JOB_ADDED / JOB_REMOVED / JOB_UPDATED keyed by job identity', () => {
    const before = x([job('1', 'Backend'), job('2', 'Designer')]);
    const after = x([job('1', 'Backend', 'Berlin'), job('3', 'Senior iOS Engineer')]);
    const changes = computeChanges(before, after);
    expect(changes.map((c) => [c.type, c.item_key])).toEqual([
      ['JOB_ADDED', 'job:3'],
      ['JOB_REMOVED', 'job:2'],
      ['JOB_UPDATED', 'job:1'],
    ]);
    expect(changes[0]!.summary).toBe('New job: Senior iOS Engineer (Remote)');
    expect(changes[0]!.search_text).toBe('senior ios engineer remote');
    expect(changes[2]!.data.changed_fields).toEqual(['location']);
  });

  it('pairs a JSON-LD job whose location changed into JOB_UPDATED instead of remove+add', () => {
    const before = x([{ key: 'job:ios|nyc', title: 'iOS Engineer', location: 'NYC', source: 'jsonld' }]);
    const after = x([{ key: 'job:ios|remote', title: 'iOS Engineer', location: 'Remote', source: 'jsonld' }]);
    expect(computeChanges(before, after)).toEqual([expect.objectContaining({ type: 'JOB_UPDATED', data: expect.objectContaining({ changed_fields: ['location'] }) })]);
  });

  it('does not pair API jobs, whose ids are stable', () => {
    const before = x([{ key: 'job:greenhouse:1', title: 'iOS Engineer', source: 'greenhouse' }]);
    const after = x([{ key: 'job:greenhouse:2', title: 'iOS Engineer', source: 'greenhouse' }]);
    expect(computeChanges(before, after).map((c) => c.type)).toEqual(['JOB_ADDED', 'JOB_REMOVED']);
  });

  it('ignores changes to untracked fields such as posted_at', () => {
    expect(computeChanges(x([{ ...job('1', 'A'), posted_at: '2030-01-01' }]), x([{ ...job('1', 'A'), posted_at: '2030-02-01' }]))).toEqual([]);
  });
});

describe('contentHash', () => {
  it('is independent of job order', () => {
    expect(contentHash(x([job('1', 'A'), job('2', 'B')]))).toBe(contentHash(x([job('2', 'B'), job('1', 'A')])));
  });

  it('changes when a job changes', () => {
    expect(contentHash(x([job('1', 'A')]))).not.toBe(contentHash(x([job('1', 'A', 'Berlin')])));
  });
});
