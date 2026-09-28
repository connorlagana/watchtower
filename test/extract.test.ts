import { describe, expect, it } from 'vitest';
import { canonicalUrl, extract, resolveSource } from '../src/extract/adapters.js';
import { extractTextDates } from '../src/extract/dates.js';
import { extractHtml, stableJsonLines } from '../src/extract/html.js';
import { extractJsonLd, parseJsonLdBlocks } from '../src/extract/jsonld.js';

describe('HTML normalization', () => {
  const page = (extra: string) => `<!doctype html><html><head><title>Pricing</title>
    <style>.a{color:red}</style><script>var t=${Math.random()}</script></head>
    <body><nav>Home</nav><main><h1>Plans</h1><p>Pro   costs
      $20</p>${extra}<!-- build ${Math.random()} --></main>
    <input type="hidden" name="csrf" value="${Math.random()}"><div hidden>secret</div></body></html>`;

  it('drops scripts, styles, comments, hidden elements and collapses whitespace', () => {
    const x = extractHtml(page(''));
    expect(x.title).toBe('Pricing');
    expect(x.text).toBe('Home\nPlans\nPro costs $20');
  });

  it('is stable across volatile noise', () => {
    const a = extractHtml(page('<p>Updated 3 minutes ago</p><p>sid=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH</p>'));
    const b = extractHtml(page('<p>Updated 12 minutes ago</p><p>sid=ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210abcdefgh</p>'));
    expect(a.text).toBe(b.text);
  });

  it('restricts comparison to a CSS selector', () => {
    const x = extractHtml(page('<section id="price"><p>Enterprise: call us</p></section>'), { selector: '#price' });
    expect(x.text).toBe('Enterprise: call us');
  });

  it('renders JSON deterministically', () => {
    expect(stableJsonLines({ b: 1, a: [true, { c: null }] })).toEqual(['a.0: true', 'a.1.c: null', 'b: 1']);
  });
});

describe('JSON-LD', () => {
  it('extracts JobPosting and Event nodes from @graph, arrays and subtypes', () => {
    const docs = parseJsonLdBlocks([
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'JobPosting', title: 'iOS Engineer', identifier: { value: 'J1' }, jobLocationType: 'TELECOMMUTE', hiringOrganization: { name: 'Acme' } },
          { '@type': 'Organization', name: 'Acme' },
        ],
      }),
      `<!-- ${JSON.stringify([{ '@type': 'MusicEvent', name: 'Live', startDate: '2026-11-02T20:00', location: { '@type': 'Place', name: 'Hall', address: { addressLocality: 'Oslo' } } }])} -->`,
      '{ not json',
    ]);
    const { jobs, events } = extractJsonLd(docs, 'https://acme.test/');
    expect(jobs).toEqual([expect.objectContaining({ key: 'job:j1', title: 'iOS Engineer', location: 'Remote', company: 'Acme' })]);
    expect(events).toEqual([expect.objectContaining({ name: 'Live', start_date: '2026-11-02T20:00', location: 'Hall, Oslo' })]);
  });

  it('keys events by date so a new date is a new event', () => {
    const mk = (d: string) => ({ '@type': 'Event', name: 'Conf', startDate: d, url: 'https://c.test/' });
    const { events } = extractJsonLd([[mk('2026-05-01'), mk('2026-06-01')]]);
    expect(new Set(events.map((e) => e.key)).size).toBe(2);
  });
});

describe('text date fallback', () => {
  it('finds dates in several formats and dedupes them', () => {
    const dates = extractTextDates('Tour\nOct 12, 2026 — Berlin\n12 October 2026 (again)\nMarch 3rd 2027 Paris\n2027-04-05 Rome\nFeb 30, 2026 invalid');
    expect(dates.map((d) => d.start_date)).toEqual(['2026-10-12', '2027-03-03', '2027-04-05']);
    expect(dates[0]!.name).toBe('Oct 12, 2026 — Berlin');
  });
});

describe('adapters', () => {
  it('maps Greenhouse and Lever boards to their public APIs for job watches', () => {
    expect(resolveSource('https://boards.greenhouse.io/acme', 'jobs')).toEqual({ adapter: 'greenhouse', fetchUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' });
    expect(resolveSource('https://job-boards.greenhouse.io/acme/jobs/123', 'jobs').fetchUrl).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs');
    expect(resolveSource('https://boards.greenhouse.io/embed/job_board?for=acme', 'jobs').fetchUrl).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs');
    expect(resolveSource('https://jobs.lever.co/acme', 'jobs')).toEqual({ adapter: 'lever', fetchUrl: 'https://api.lever.co/v0/postings/acme?mode=json' });
    expect(resolveSource('https://jobs.eu.lever.co/acme/abc', 'jobs').fetchUrl).toBe('https://api.eu.lever.co/v0/postings/acme?mode=json');
  });

  it('keeps page watches on the HTML adapter', () => {
    expect(resolveSource('https://boards.greenhouse.io/acme', 'url').adapter).toBe('html');
    expect(resolveSource('https://acme.test/careers#top', 'jobs')).toEqual({ adapter: 'html', fetchUrl: 'https://acme.test/careers' });
  });

  it('canonicalizes URLs', () => {
    expect(canonicalUrl('HTTPS://Example.COM:443/a?b=1#frag')).toBe('https://example.com/a?b=1');
  });

  it('parses Greenhouse job-board API responses', () => {
    const x = extract(
      'greenhouse',
      JSON.stringify({ jobs: [{ id: 7, title: 'iOS Engineer ', location: { name: 'NYC' }, absolute_url: 'https://x/7', departments: [{ name: 'Mobile' }] }] }),
      'application/json',
    );
    expect(x.jobs).toEqual([{ key: 'job:greenhouse:7', title: 'iOS Engineer', location: 'NYC', department: 'Mobile', url: 'https://x/7', posted_at: undefined, source: 'greenhouse' }]);
    expect(x.text).toBe('iOS Engineer — NYC — Mobile');
  });

  it('parses Lever postings API responses', () => {
    const x = extract('lever', JSON.stringify([{ id: 'abc', text: 'Android Dev', categories: { location: 'Remote', team: 'Mobile' }, hostedUrl: 'https://l/abc', createdAt: 0 }]), 'application/json');
    expect(x.jobs[0]).toMatchObject({ key: 'job:lever:abc', title: 'Android Dev', location: 'Remote', department: 'Mobile', posted_at: '1970-01-01T00:00:00.000Z' });
  });

  it('handles JSON and plain text resources', () => {
    expect(extract('html', '{"b":2,"a":1}', 'application/json').text).toBe('a: 1\nb: 2');
    expect(extract('html', 'hello   world\n\n  bye ', 'text/plain').text).toBe('hello world\nbye');
  });
});
