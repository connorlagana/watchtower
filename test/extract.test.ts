import { describe, expect, it } from 'vitest';
import { canonicalUrl, extract, resolveSource } from '../src/extract/adapters.js';
import { extractHtml } from '../src/extract/html.js';
import { extractJsonLd, parseJsonLdBlocks } from '../src/extract/jsonld.js';

describe('careers pages', () => {
  it('reads jobs from JobPosting JSON-LD and ignores the visible text', () => {
    const ld = { '@type': 'JobPosting', identifier: 'J1', title: 'iOS Engineer', url: '/jobs/1', hiringOrganization: { name: 'Acme' } };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Careers</h1><p>Android Engineer</p></body></html>`;
    expect(extractHtml(html, { baseUrl: 'https://acme.test/careers' }).jobs).toEqual([
      expect.objectContaining({ key: 'job:j1', title: 'iOS Engineer', company: 'Acme', url: 'https://acme.test/jobs/1', source: 'jsonld' }),
    ]);
  });

  it('finds no jobs on a page without JobPosting markup', () => {
    expect(extractHtml('<html><body><h1>Careers</h1><p>iOS Engineer</p></body></html>').jobs).toEqual([]);
  });
});

describe('JSON-LD', () => {
  it('extracts JobPosting nodes from @graph, arrays and commented-out blocks', () => {
    const docs = parseJsonLdBlocks([
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'JobPosting', title: 'iOS Engineer', identifier: { value: 'J1' }, jobLocationType: 'TELECOMMUTE', hiringOrganization: { name: 'Acme' } },
          { '@type': 'Organization', name: 'Acme' },
        ],
      }),
      `<!-- ${JSON.stringify([{ '@type': 'JobPosting', title: 'Designer', jobLocation: { '@type': 'Place', address: { addressLocality: 'Oslo' } } }])} -->`,
      '{ not json',
    ]);
    const { jobs } = extractJsonLd(docs, 'https://acme.test/');
    expect(jobs).toEqual([
      expect.objectContaining({ key: 'job:j1', title: 'iOS Engineer', location: 'Remote', company: 'Acme' }),
      expect.objectContaining({ key: 'job:designer|oslo', title: 'Designer', location: 'Oslo' }),
    ]);
  });

  it('ignores non-job schema.org types', () => {
    expect(extractJsonLd([{ '@type': 'Event', name: 'Conf', startDate: '2030-01-01' }]).jobs).toEqual([]);
  });
});

describe('adapters', () => {
  it('maps Greenhouse and Lever boards to their public APIs for job watches', () => {
    expect(resolveSource('https://boards.greenhouse.io/acme')).toEqual({ adapter: 'greenhouse', fetchUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' });
    expect(resolveSource('https://job-boards.greenhouse.io/acme/jobs/123').fetchUrl).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs');
    expect(resolveSource('https://boards.greenhouse.io/embed/job_board?for=acme').fetchUrl).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs');
    expect(resolveSource('https://jobs.lever.co/acme')).toEqual({ adapter: 'lever', fetchUrl: 'https://api.lever.co/v0/postings/acme?mode=json' });
    expect(resolveSource('https://jobs.eu.lever.co/acme/abc').fetchUrl).toBe('https://api.eu.lever.co/v0/postings/acme?mode=json');
  });

  it('reads other careers pages through the HTML adapter', () => {
    expect(resolveSource('https://acme.test/careers#top')).toEqual({ adapter: 'html', fetchUrl: 'https://acme.test/careers' });
  });

  it('canonicalizes URLs, dropping tracking parameters and sorting the query', () => {
    expect(canonicalUrl('HTTPS://Example.COM:443/a?b=1#frag')).toBe('https://example.com/a?b=1');
    expect(canonicalUrl('https://x.test/p?utm_source=nl&z=2&fbclid=abc&a=1&gclid=q')).toBe('https://x.test/p?a=1&z=2');
    expect(canonicalUrl('https://x.test/p?utm_campaign=x')).toBe('https://x.test/p');
  });

  it('maps Ashby, Workable, SmartRecruiters and Recruitee boards to their public APIs', () => {
    expect(resolveSource('https://jobs.ashbyhq.com/acme')).toEqual({ adapter: 'ashby', fetchUrl: 'https://api.ashbyhq.com/posting-api/job-board/acme' });
    expect(resolveSource('https://apply.workable.com/acme/')).toEqual({ adapter: 'workable', fetchUrl: 'https://apply.workable.com/api/v1/widget/accounts/acme' });
    expect(resolveSource('https://acme.workable.com/').adapter).toBe('workable');
    expect(resolveSource('https://jobs.smartrecruiters.com/Acme1')).toEqual({ adapter: 'smartrecruiters', fetchUrl: 'https://api.smartrecruiters.com/v1/companies/Acme1/postings?limit=100' });
    expect(resolveSource('https://acme.recruitee.com/o/ios')).toEqual({ adapter: 'recruitee', fetchUrl: 'https://acme.recruitee.com/api/offers/' });
  });

  it('parses Ashby, Workable, SmartRecruiters and Recruitee responses', () => {
    expect(
      extract('ashby', JSON.stringify({ jobs: [{ id: 'a1', title: 'iOS Eng', location: 'NYC', isRemote: true, department: 'Eng', jobUrl: 'https://j/a1', isListed: true }, { id: 'h', title: 'Hidden', isListed: false }] }), 'application/json').jobs,
    ).toEqual([{ key: 'job:ashby:a1', title: 'iOS Eng', location: 'NYC, Remote', department: 'Eng', url: 'https://j/a1', posted_at: undefined, source: 'ashby', remote: true, seniority: 'mid' }]);
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
    expect(x.jobs).toEqual([{ key: 'job:greenhouse:7', title: 'iOS Engineer', location: 'NYC', department: 'Mobile', url: 'https://x/7', posted_at: undefined, source: 'greenhouse', remote: false, seniority: 'mid' }]);
  });

  it('parses Lever postings API responses', () => {
    const x = extract('lever', JSON.stringify([{ id: 'abc', text: 'Android Dev', categories: { location: 'Remote', team: 'Mobile' }, hostedUrl: 'https://l/abc', createdAt: 0 }]), 'application/json');
    expect(x.jobs[0]).toMatchObject({ key: 'job:lever:abc', title: 'Android Dev', location: 'Remote', department: 'Mobile', posted_at: '1970-01-01T00:00:00.000Z' });
  });

  it('reads standalone JSON-LD documents and finds no jobs in other content', () => {
    expect(extract('html', JSON.stringify({ '@type': 'JobPosting', title: 'PM' }), 'application/ld+json').jobs).toHaveLength(1);
    expect(extract('html', '{"b":2,"a":1}', 'application/json').jobs).toEqual([]);
    expect(extract('html', 'iOS Engineer', 'text/plain').jobs).toEqual([]);
  });
});
