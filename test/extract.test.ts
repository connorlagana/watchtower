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

  it('drops scripts, styles, comments, hidden elements and navigation, and collapses whitespace', () => {
    const x = extractHtml(page(''));
    expect(x.title).toBe('Pricing');
    expect(x.text).toBe('Plans\nPro costs $20');
  });

  it('prefers main content and drops site chrome and consent banners', () => {
    const html = `<html><body><header><a>Logo</a> Sale ends in 3h</header><div class="cookie-banner">We use cookies. Accept?</div>
      <main><h1>Jobs</h1><p>${'Real content. '.repeat(30)}</p></main><aside>Trending: A</aside><footer>© 2030 · Updated daily</footer></body></html>`;
    const x = extractHtml(html);
    expect(x.text.startsWith('Jobs\nReal content.')).toBe(true);
    expect(x.text).not.toMatch(/cookies|Trending|Sale ends|©/);
  });

  it('keeps pages that are nothing but "chrome"', () => {
    expect(extractHtml('<html><body><nav>Only nav text here</nav></body></html>').text).toBe('Only nav text here');
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

  it('keys JSON arrays by id so inserting an element does not renumber the rest', () => {
    const before = stableJsonLines({ items: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] });
    const after = stableJsonLines({ items: [{ id: 'z', v: 0 }, { id: 'a', v: 1 }, { id: 'b', v: 2 }] });
    expect(after.filter((l) => !before.includes(l))).toEqual(['items.[id=z].id: "z"', 'items.[id=z].v: 0']);
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

describe('feeds', () => {
  it('parses RSS items', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
      <item><title>Hello</title><link>https://b.test/hello</link><guid>g1</guid><pubDate>Mon, 01 Jan 2030 00:00:00 GMT</pubDate></item>
      <item><title><![CDATA[Second <b>post</b>]]></title><link>https://b.test/2</link></item></channel></rss>`;
    const x = extract('html', rss, 'application/rss+xml');
    expect(x.isFeed).toBe(true);
    expect(x.title).toBe('Blog');
    expect(x.items).toEqual([
      expect.objectContaining({ key: 'item:g1', title: 'Hello', url: 'https://b.test/hello' }),
      expect.objectContaining({ key: 'item:https://b.test/2', title: 'Second post' }),
    ]);
  });

  it('parses Atom entries (sniffed from the body)', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Changelog</title>
      <entry><id>urn:1</id><title>v2.0</title><link rel="alternate" href="/v2"/><updated>2030-01-01T00:00:00Z</updated></entry></feed>`;
    const x = extract('html', atom, 'application/xml', { baseUrl: 'https://c.test/feed' });
    expect(x.items).toEqual([expect.objectContaining({ key: 'item:urn:1', title: 'v2.0', url: 'https://c.test/v2' })]);
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

  it('canonicalizes URLs, dropping tracking parameters and sorting the query', () => {
    expect(canonicalUrl('HTTPS://Example.COM:443/a?b=1#frag')).toBe('https://example.com/a?b=1');
    expect(canonicalUrl('https://x.test/p?utm_source=nl&z=2&fbclid=abc&a=1&gclid=q')).toBe('https://x.test/p?a=1&z=2');
    expect(canonicalUrl('https://x.test/p?utm_campaign=x')).toBe('https://x.test/p');
  });

  it('maps Ashby, Workable, SmartRecruiters and Recruitee boards to their public APIs', () => {
    expect(resolveSource('https://jobs.ashbyhq.com/acme', 'jobs')).toEqual({ adapter: 'ashby', fetchUrl: 'https://api.ashbyhq.com/posting-api/job-board/acme' });
    expect(resolveSource('https://apply.workable.com/acme/', 'jobs')).toEqual({ adapter: 'workable', fetchUrl: 'https://apply.workable.com/api/v1/widget/accounts/acme' });
    expect(resolveSource('https://acme.workable.com/', 'jobs').adapter).toBe('workable');
    expect(resolveSource('https://jobs.smartrecruiters.com/Acme1', 'jobs')).toEqual({ adapter: 'smartrecruiters', fetchUrl: 'https://api.smartrecruiters.com/v1/companies/Acme1/postings?limit=100' });
    expect(resolveSource('https://acme.recruitee.com/o/ios', 'jobs')).toEqual({ adapter: 'recruitee', fetchUrl: 'https://acme.recruitee.com/api/offers/' });
  });

  it('parses Ashby, Workable, SmartRecruiters and Recruitee responses', () => {
    expect(
      extract('ashby', JSON.stringify({ jobs: [{ id: 'a1', title: 'iOS Eng', location: 'NYC', isRemote: true, department: 'Eng', jobUrl: 'https://j/a1', isListed: true }, { id: 'h', title: 'Hidden', isListed: false }] }), 'application/json').jobs,
    ).toEqual([{ key: 'job:ashby:a1', title: 'iOS Eng', location: 'NYC, Remote', department: 'Eng', url: 'https://j/a1', posted_at: undefined, source: 'ashby' }]);
    expect(
      extract('workable', JSON.stringify({ name: 'Acme', jobs: [{ shortcode: 'W1', title: 'Designer', city: 'Berlin', country: 'Germany', url: 'https://w/W1' }] }), 'application/json').jobs[0],
    ).toMatchObject({ key: 'job:workable:w1'.replace('w1', 'W1'), title: 'Designer', location: 'Berlin, Germany', company: 'Acme' });
    expect(
      extract('smartrecruiters', JSON.stringify({ content: [{ id: '99', name: 'Android Dev', location: { city: 'Paris', remote: true }, department: { label: 'Mobile' } }] }), 'application/json', {
        baseUrl: 'https://api.smartrecruiters.com/v1/companies/Acme1/postings?limit=100',
      }).jobs[0],
    ).toMatchObject({ title: 'Android Dev', location: 'Paris, Remote', department: 'Mobile', url: 'https://jobs.smartrecruiters.com/Acme1/99' });
    expect(
      extract('recruitee', JSON.stringify({ offers: [{ id: 5, title: 'PM', location: 'Remote', careers_url: 'https://r/5' }] }), 'application/json').jobs[0],
    ).toMatchObject({ key: 'job:recruitee:5', title: 'PM', location: 'Remote', url: 'https://r/5' });
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
