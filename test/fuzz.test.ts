/**
 * Property-based tests: parsers see arbitrary third-party input and must never
 * throw (except the documented PARSE_ERROR paths for platform APIs), and the
 * diff must be consistent with its inputs.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extract } from '../src/extract/adapters.js';
import { extractTextDates } from '../src/extract/dates.js';
import { computeChanges, diffLines, wordDiff } from '../src/extract/diff.js';
import { extractFeed } from '../src/extract/feed.js';
import { extractHtml, stableJsonLines } from '../src/extract/html.js';
import { extractJsonLd, parseJsonLdBlocks } from '../src/extract/jsonld.js';
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
    '@type': fc.constantFrom('JobPosting', 'Event', 'MusicEvent', 'Organization', ['Event', 'Thing']),
    title: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    name: fc.oneof(fc.string(), fc.record({ name: fc.string() })),
    startDate: fc.oneof(fc.string(), fc.date({ noInvalidDate: true }).map((d) => d.toISOString())),
    location: fc.oneof(fc.string(), fc.jsonValue()),
    jobLocation: fc.jsonValue(),
    identifier: fc.oneof(fc.string(), fc.record({ value: fc.string() })),
    '@graph': fc.array(fc.jsonValue(), { maxLength: 3 }),
  },
  { requiredKeys: ['@type'] },
);

describe('parsers never throw on arbitrary input', () => {
  it('extractHtml', () => {
    fc.assert(
      fc.property(htmlish, (html) => {
        const x = extractHtml(`<html><body>${html}</body></html>`);
        expect(typeof x.text).toBe('string');
        expect(x.text).not.toMatch(/\n\n/);
      }),
      { numRuns: 300 },
    );
  });

  it('JSON-LD extraction on arbitrary JSON and schema-shaped nodes', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.jsonValue(), ldNode), { maxLength: 5 }), fc.string(), (docs, junk) => {
        const parsed = parseJsonLdBlocks([...docs.map((d) => JSON.stringify(d)), junk]);
        const { jobs, events } = extractJsonLd(parsed, 'https://base.test/');
        for (const j of jobs) expect(typeof j.title).toBe('string');
        for (const e of events) expect(typeof e.name).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  it('feeds, dates, robots and generic text/JSON bodies', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (body) => {
        extractFeed(`<rss><channel><item><title>${body}</title></item></channel></rss>`);
        extractFeed(body);
        extractTextDates(body);
        const rules = parseRobots(body);
        expect(typeof isAllowed(rules, '/x')).toBe('boolean');
        extract('html', body, 'text/plain');
        extract('html', body, 'application/json');
        extract('html', body, '');
      }),
      { numRuns: 300 },
    );
  });

  it('stableJsonLines is deterministic', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(stableJsonLines(v)).toEqual(stableJsonLines(JSON.parse(JSON.stringify(v))));
      }),
    );
  });
});

describe('diff invariants', () => {
  const lines = fc.array(fc.string({ maxLength: 20 }).map((s) => s.replace(/\n/g, ' ')), { maxLength: 30 });

  it('diffLines accounts for every line (multiset semantics)', () => {
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const { added, removed } = diffLines(a.join('\n'), b.join('\n'));
        const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
        const ca = count(a.join('\n') ? a.join('\n').split('\n') : []);
        const cb = count(b.join('\n') ? b.join('\n').split('\n') : []);
        for (const l of new Set([...ca.keys(), ...cb.keys()])) {
          const diff = (cb.get(l) ?? 0) - (ca.get(l) ?? 0);
          expect(added.filter((x) => x === l).length - removed.filter((x) => x === l).length).toBe(diff);
        }
      }),
    );
  });

  it('identical extractions never produce changes; wordDiff never throws', () => {
    fc.assert(
      fc.property(lines, fc.string(), fc.string(), (a, s1, s2) => {
        const x = { title: null, text: a.join('\n'), jobs: [], events: [] };
        expect(computeChanges(x, { ...x }).changes).toEqual([]);
        wordDiff(s1, s2);
      }),
    );
  });
});
