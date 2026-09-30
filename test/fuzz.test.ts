/**
 * Property-based tests: parsers see arbitrary third-party input and must never
 * throw (except the documented PARSE_ERROR paths for platform APIs), and the
 * diff must be consistent with its inputs.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extract } from '../src/extract/adapters.js';
import { computeChanges, contentHash } from '../src/extract/diff.js';
import { extractHtml } from '../src/extract/html.js';
import { extractJsonLd, parseJsonLdBlocks } from '../src/extract/jsonld.js';
import type { JobItem } from '../src/extract/types.js';
import { isAllowed, parseRobots } from '../src/fetch/robots.js';

const tag = fc.constantFrom('div', 'p', 'main', 'nav', 'script', 'style', 'article', 'header', 'footer', 'li', 'span', 'template', 'svg');
const htmlish: fc.Arbitrary<string> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    fc.string(),
    fc.tuple(tag, fc.array(tie('node'), { maxLength: 4 })).map(([t, kids]) => `<${t} class="${t}">${(kids as string[]).join('')}</${t}>`),
    fc.jsonValue().map((v) => `<script type="application/ld+json">${JSON.stringify(v)}</script>`),
  ),
})).node as fc.Arbitrary<string>;

const ldNode = fc.record(
  {
    '@type': fc.constantFrom('JobPosting', 'Event', 'Organization', ['JobPosting', 'Thing']),
    title: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    name: fc.oneof(fc.string(), fc.record({ name: fc.string() })),
    jobLocation: fc.jsonValue(),
    hiringOrganization: fc.oneof(fc.string(), fc.jsonValue()),
    identifier: fc.oneof(fc.string(), fc.record({ value: fc.string() })),
    '@graph': fc.array(fc.jsonValue(), { maxLength: 3 }),
  },
  { requiredKeys: ['@type'] },
);

describe('parsers never throw on arbitrary input', () => {
  it('extractHtml', () => {
    fc.assert(
      fc.property(htmlish, (html) => {
        for (const j of extractHtml(`<html><body>${html}</body></html>`).jobs) expect(typeof j.title).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  it('JSON-LD extraction on arbitrary JSON and schema-shaped nodes', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.jsonValue(), ldNode), { maxLength: 5 }), fc.string(), (docs, junk) => {
        const parsed = parseJsonLdBlocks([...docs.map((d) => JSON.stringify(d)), junk]);
        for (const j of extractJsonLd(parsed, 'https://base.test/').jobs) expect(typeof j.title).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  it('robots and generic bodies', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (body) => {
        const rules = parseRobots(body);
        expect(typeof isAllowed(rules, '/x')).toBe('boolean');
        extract('html', body, 'text/html');
        extract('html', body, 'application/ld+json');
        extract('html', body, '');
      }),
      { numRuns: 300 },
    );
  });
});

describe('diff invariants', () => {
  const jobs = fc.uniqueArray(
    fc.record({ key: fc.string({ maxLength: 8 }).map((k) => `job:${k}`), title: fc.string({ maxLength: 10 }), location: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }) }),
    { selector: (j) => j.key, maxLength: 20 },
  ).map((list) => list.map((j): JobItem => ({ ...j, source: 'greenhouse' })));

  it('identical job sets never produce changes, in any order', () => {
    fc.assert(
      fc.property(jobs, (a) => {
        expect(computeChanges({ jobs: a }, { jobs: [...a].reverse() })).toEqual([]);
        expect(contentHash({ jobs: a })).toBe(contentHash({ jobs: [...a].reverse() }));
      }),
    );
  });

  it('every added and removed key is reported exactly once', () => {
    fc.assert(
      fc.property(jobs, jobs, (a, b) => {
        const changes = computeChanges({ jobs: a }, { jobs: b });
        const aKeys = new Set(a.map((j) => j.key));
        const bKeys = new Set(b.map((j) => j.key));
        expect(changes.filter((c) => c.type === 'JOB_ADDED').map((c) => c.item_key).sort()).toEqual([...bKeys].filter((k) => !aKeys.has(k)).sort());
        expect(changes.filter((c) => c.type === 'JOB_REMOVED').map((c) => c.item_key).sort()).toEqual([...aKeys].filter((k) => !bKeys.has(k)).sort());
      }),
    );
  });
});
