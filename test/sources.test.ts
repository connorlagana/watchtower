import { describe, expect, it } from 'vitest';
import { boardPageUrl, collect, resolveSource } from '../src/extract/adapters.js';
import { BOARDS } from '../src/search/boards.js';
import { isRemote, seniorityOf } from '../src/extract/classify.js';
import { computeChanges } from '../src/extract/diff.js';
import { collectIcims, parseIcimsSearch, parseIcimsSitemap, searchUrlFor } from '../src/extract/icims.js';
import { collectWorkday, MAX_JOBS, PAGE_SIZE, parseWorkdayPage } from '../src/extract/workday.js';

describe('classify', () => {
  it('derives seniority from the title, management before IC level', () => {
    expect(seniorityOf('Software Engineer')).toBe('mid');
    expect(seniorityOf('Senior Software Engineer')).toBe('senior');
    expect(seniorityOf('Sr. iOS Engineer')).toBe('senior');
    expect(seniorityOf('Staff Engineer')).toBe('staff');
    expect(seniorityOf('Principal Engineer')).toBe('principal');
    expect(seniorityOf('Senior Engineering Manager')).toBe('manager');
    expect(seniorityOf('Associate Director, Marketing')).toBe('director');
    expect(seniorityOf('Associate Product Manager')).toBe('manager');
    expect(seniorityOf('Software Engineer I')).toBe('entry');
    expect(seniorityOf('Software Engineer III')).toBe('senior');
    expect(seniorityOf('Software Engineering Intern (Summer 2027)')).toBe('intern');
    expect(seniorityOf('New Grad Software Engineer')).toBe('entry');
  });

  it('detects remote from title or location, but not hybrid or on-site', () => {
    expect(isRemote('Backend Engineer', 'Remote - US')).toBe(true);
    expect(isRemote('Remote Backend Engineer', 'Berlin')).toBe(true);
    expect(isRemote('Backend Engineer', 'Berlin (hybrid)')).toBe(false);
    expect(isRemote('Backend Engineer', 'US-CA-Remote')).toBe(true);
    expect(isRemote('Distributed Systems Engineer', 'Durham')).toBe(false);
    expect(isRemote('Engineer', 'Remote - no remote outside Canada')).toBe(false);
  });
});

describe('Workday', () => {
  const api = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  const posting = (id: string, title: string, loc = 'Berlin') => ({ title, externalPath: `/job/US-CA-Santa-Clara/${title.replace(/\s/g, '-')}_${id}`, locationsText: loc, postedOn: 'Posted Today', bulletFields: [id] });
  const page = (total: number, ...jobs: ReturnType<typeof posting>[]) => JSON.stringify({ total, jobPostings: jobs });

  it('maps career-site URLs (with or without a locale) to the search endpoint', () => {
    expect(resolveSource('https://acme.wd5.myworkdayjobs.com/Careers')).toEqual({ adapter: 'workday', fetchUrl: api });
    expect(resolveSource('https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Berlin/Engineer_JR1')).toEqual({ adapter: 'workday', fetchUrl: api });
    expect(resolveSource('https://wd3.myworkdaysite.com/recruiting/acme/External').fetchUrl).toBe('https://wd3.myworkdaysite.com/wday/cxs/acme/External/jobs');
    expect(resolveSource('https://acme.wd5.myworkdayjobs.com/').adapter).toBe('html');
  });

  it('parses postings, keys by requisition id, links to the public site and expands "N Locations"', () => {
    const { jobs, total } = parseWorkdayPage(page(1, posting('JR7', 'Senior Engineer', '3 Locations')), api);
    expect(total).toBe(1);
    expect(jobs).toEqual([
      { key: 'job:workday:jr7', title: 'Senior Engineer', location: 'US CA Santa Clara (+2 more)', url: 'https://acme.wd5.myworkdayjobs.com/Careers/job/US-CA-Santa-Clara/Senior-Engineer_JR7', source: 'workday' },
    ]);
  });

  it('pages through the newest MAX_JOBS and marks larger boards incomplete', async () => {
    const offsets: number[] = [];
    const post = async (offset: number) => {
      offsets.push(offset);
      return page(0, ...Array.from({ length: PAGE_SIZE }, (_, i) => posting(`JR${offset + i}`, `Role ${offset + i}`)));
    };
    const small = await collectWorkday(api, page(25, ...Array.from({ length: PAGE_SIZE }, (_, i) => posting(`JR${i}`, `Role ${i}`))), post);
    expect(offsets).toEqual([20]);
    expect(small.jobs).toHaveLength(40);
    expect(small.complete).toBe(true);

    offsets.length = 0;
    const big = await collectWorkday(api, page(2000, ...Array.from({ length: PAGE_SIZE }, (_, i) => posting(`JR${i}`, `Role ${i}`))), post);
    expect(offsets).toEqual(Array.from({ length: MAX_JOBS / PAGE_SIZE - 1 }, (_, i) => (i + 1) * PAGE_SIZE));
    expect(big.jobs).toHaveLength(MAX_JOBS);
    expect(big.complete).toBe(false);
  });

  it('never reports removals from an incomplete listing', () => {
    const j = (k: string) => ({ key: `job:workday:${k}`, title: k, source: 'workday' as const });
    expect(computeChanges({ jobs: [j('a'), j('b')] }, { jobs: [j('c'), j('a')], complete: false }).map((c) => c.type)).toEqual(['JOB_ADDED']);
    expect(computeChanges({ jobs: [j('a'), j('b')] }, { jobs: [j('c'), j('a')], complete: true }).map((c) => c.type)).toEqual(['JOB_ADDED', 'JOB_REMOVED']);
  });

  it('collect() posts follow-up pages through the supplied fetcher', async () => {
    const calls: [string, string | undefined][] = [];
    const more = async (url: string, body?: string) => {
      calls.push([url, body]);
      return page(0, posting('JR21', 'Role 21'));
    };
    const x = await collect('workday', api, { body: page(21, posting('JR1', 'Role 1')), contentType: 'application/json', finalUrl: api }, more);
    expect(calls).toEqual([[api, JSON.stringify({ appliedFacets: {}, limit: 20, offset: 20, searchText: '' })]]);
    expect(x.jobs.map((j) => j.key)).toEqual(['job:workday:jr1', 'job:workday:jr21']);
    expect(x.jobs[0]).toMatchObject({ remote: false, seniority: 'mid' });
  });
});

describe('iCIMS', () => {
  const sitemap = `<?xml version='1.0' encoding='utf-8'?><urlset><url><loc>https://careers-acme.icims.com/jobs/intro</loc></url>
    <url><loc>https://careers-acme.icims.com/jobs/101/systems-administration---active-directory/job</loc><lastmod>2026-09-29</lastmod></url>
    <url><loc>https://careers-acme.icims.com/jobs/102/lead-electronics-technician-%28nasa%29/job</loc></url>
    <url><loc>https://careers-acme.icims.com/jobs/102/lead-electronics-technician-%28nasa%29/job?mode=apply</loc></url></urlset>`;
  const search = `<html><body><ul><li class="iCIMS_JobCardItem"><div class="row">
      <div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span><span> US-TX-Palestine</span></div>
      <div class="col-xs-6 header right"><span title="9/29/2026 3:15 PM"> 6 hours ago</span></div>
      <div class="col-xs-12 title"><a href="https://careers-acme.icims.com/jobs/102/lead-electronics-technician-%28nasa%29/job?in_iframe=1" class="iCIMS_Anchor">
        <span class="sr-only field-label">External Job Posting Title</span><h3> Lead Electronics Technician (NASA)</h3></a></div></div></li></ul></body></html>`;

  it('maps career portals to their sitemap and search page', () => {
    expect(resolveSource('https://careers-acme.icims.com/jobs/search?ss=1')).toEqual({ adapter: 'icims', fetchUrl: 'https://careers-acme.icims.com/sitemap.xml' });
    expect(resolveSource('https://www.icims.com/').adapter).toBe('html');
    expect(searchUrlFor('https://careers-acme.icims.com/sitemap.xml')).toBe('https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1');
  });

  it('reads every job from the sitemap as a partial entry with a title from the slug', () => {
    expect(parseIcimsSitemap(sitemap)).toEqual([
      { key: 'job:icims:101', title: 'Systems Administration - Active Directory', url: 'https://careers-acme.icims.com/jobs/101/systems-administration---active-directory/job', source: 'icims', partial: true },
      { key: 'job:icims:102', title: 'Lead Electronics Technician (Nasa)', url: 'https://careers-acme.icims.com/jobs/102/lead-electronics-technician-%28nasa%29/job', source: 'icims', partial: true },
    ]);
  });

  it('reads title, location and posting date from the search page', () => {
    expect(parseIcimsSearch(search)).toEqual([
      { key: 'job:icims:102', title: 'Lead Electronics Technician (NASA)', location: 'US-TX-Palestine', url: 'https://careers-acme.icims.com/jobs/102/lead-electronics-technician-%28nasa%29/job', posted_at: '2026-09-29', source: 'icims' },
    ]);
  });

  it('lets search rows override sitemap entries and keeps the list complete', () => {
    const x = collectIcims(sitemap, search);
    expect(x.complete).toBe(true);
    expect(x.jobs.map((j) => [j.key, j.partial ?? false, j.title])).toEqual([
      ['job:icims:101', true, 'Systems Administration - Active Directory'],
      ['job:icims:102', false, 'Lead Electronics Technician (NASA)'],
    ]);
  });

  it('does not report a partial entry becoming a full one as an update', () => {
    const before = { jobs: [{ key: 'job:icims:1', title: 'Backend Engineer', source: 'icims' as const, partial: true }] };
    const after = { jobs: [{ key: 'job:icims:1', title: 'Backend Engineer', location: 'Berlin', source: 'icims' as const }] };
    expect(computeChanges(before, after)).toEqual([]);
  });
});

describe('board page URLs', () => {
  it('gives every board a public page that resolves back to the same board', () => {
    const boards = [
      ...BOARDS,
      'https://job-boards.eu.greenhouse.io/acme',
      'https://jobs.eu.lever.co/acme',
      'https://jobs.smartrecruiters.com/Acme',
      'https://acme.recruitee.com/',
      'https://acme.wd5.myworkdayjobs.com/en-US/Careers',
      'https://wd3.myworkdaysite.com/recruiting/acme/External',
      'https://careers-acme.icims.com/jobs/search',
    ];
    for (const url of boards) {
      const source = resolveSource(url);
      expect(source.adapter, url).not.toBe('html');
      expect(resolveSource(boardPageUrl(source.adapter, source.fetchUrl)), url).toEqual(source);
    }
    expect(boardPageUrl('greenhouse', 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs')).toBe('https://job-boards.greenhouse.io/stripe');
    expect(boardPageUrl('lever', 'https://api.lever.co/v0/postings/palantir?mode=json')).toBe('https://jobs.lever.co/palantir');
  });
});
