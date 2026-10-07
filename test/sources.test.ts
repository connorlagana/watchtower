import { describe, expect, it } from 'vitest';
import { boardPageUrl, collect, resolveSource } from '../src/extract/adapters.js';
import { collectAmazon, MAX_JOBS as AMAZON_MAX_JOBS, pageUrl as amazonPageUrl, parseAmazonPage } from '../src/extract/amazon.js';
import { collectApple, MAX_JOBS as APPLE_MAX_JOBS, PAGE_SIZE as APPLE_PAGE_SIZE, parseApplePage } from '../src/extract/apple.js';
import { collectEightfold, MAX_JOBS as EF_MAX_JOBS, pageUrl as efPageUrl, parseEightfoldPage } from '../src/extract/eightfold.js';
import { collectOracle, MAX_JOBS as ORACLE_MAX_JOBS, pageUrl as oraclePageUrl, parseOraclePage } from '../src/extract/oracle.js';
import { collectSuccessFactors, MAX_JOBS as SF_MAX_JOBS, MAX_PAGES as SF_MAX_PAGES, pageUrl as sfPageUrl, parseSuccessFactorsPage } from '../src/extract/successfactors.js';
import { collectMicrosoft, MAX_JOBS as MS_MAX_JOBS, pageUrl as msPageUrl, parseMicrosoftPage } from '../src/extract/microsoft.js';
import { parseGoogleSitemap } from '../src/extract/google.js';
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

describe('Apple', () => {
  const api = 'https://jobs.apple.com/api/v1/search';
  const loc = (name: string, countryName: string) => ({ name, countryName, city: '', postLocationId: `postLocation-${name}` });
  const role = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    positionId: id.replace(/^PIPE-|-\d+$/g, ''),
    postingTitle: title,
    transformedPostingTitle: title.toLowerCase().replace(/\W+/g, '-'),
    postDateInGMT: '2026-10-06T01:52:04.545Z',
    locations: [loc('Cupertino', 'United States of America')],
    team: { teamName: 'Software and Services', teamCode: 'SFTWR' },
    jobSummary: 'Build the frameworks behind every app. You have 5+ years of experience shipping iOS software.',
    homeOffice: false,
    ...extra,
  });
  const page = (total: number, ...roles: ReturnType<typeof role>[]) => JSON.stringify({ res: { searchResults: roles, totalRecords: total } });

  it('maps any jobs.apple.com URL to the search endpoint', () => {
    expect(resolveSource('https://jobs.apple.com/en-us/search?team=SFTWR')).toEqual({ adapter: 'apple', fetchUrl: api });
    expect(resolveSource('https://jobs.apple.com/en-gb/details/200668060-0836/senior-leader')).toEqual({ adapter: 'apple', fetchUrl: api });
    expect(resolveSource('https://www.apple.com/careers/us/').adapter).toBe('html');
  });

  it('parses roles with team, every location, a details link and the summary', () => {
    const { jobs, total } = parseApplePage(
      page(2, role('200668060-0836', 'Senior iOS Engineer', { locations: [loc('Cupertino', 'United States of America'), loc('Austin', 'United States of America')] })),
    );
    expect(total).toBe(2);
    expect(jobs).toEqual([
      {
        key: 'job:apple:200668060-0836',
        title: 'Senior iOS Engineer',
        location: 'Cupertino, United States of America',
        other_locations: ['Austin, United States of America'],
        department: 'Software and Services',
        company: 'Apple',
        url: 'https://jobs.apple.com/en-us/details/200668060-0836/senior-ios-engineer',
        posted_at: '2026-10-06T01:52:04.545Z',
        source: 'apple',
        experience_years: 5,
      },
    ]);
  });

  it('marks home-office roles remote and drops the request-time date of evergreen roles', () => {
    const [home, pipe] = parseApplePage(
      page(
        2,
        role('200600001-0157', 'Technical Specialist', { homeOffice: true }),
        role('PIPE-200313970', 'US - Specialist: Seasonal, Part-time', { postDateInGMT: '2026-10-06T02:58:12.914728295Z', locations: [loc('United States', 'United States')] }),
      ),
    ).jobs;
    expect(home!.location).toBe('Cupertino, United States of America, Remote');
    expect(pipe).toMatchObject({ location: 'United States', posted_at: undefined });
  });

  it('pages through the newest MAX_JOBS and marks larger listings incomplete', async () => {
    const pages: number[] = [];
    const post = async (n: number) => {
      pages.push(n);
      return page(0, ...Array.from({ length: APPLE_PAGE_SIZE }, (_, i) => role(`${n}${i}-1`, `Role ${n}-${i}`)));
    };
    const x = await collectApple(page(6201, role('1-1', 'Role 1')), post);
    expect(pages).toEqual(Array.from({ length: APPLE_MAX_JOBS / APPLE_PAGE_SIZE - 1 }, (_, i) => i + 2));
    expect(x.complete).toBe(false);
  });

  it('collect() posts follow-up pages through the supplied fetcher', async () => {
    const calls: [string, string | undefined][] = [];
    const more = async (url: string, body?: string) => {
      calls.push([url, body]);
      return page(0, role('2-1', 'Machine Learning Engineer'));
    };
    const x = await collect('apple', api, { body: page(21, role('1-1', 'Staff Software Engineer')), contentType: 'application/json', finalUrl: api }, more);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]![1]!)).toMatchObject({ page: 2, sort: 'newest', locale: 'en-us' });
    expect(x.complete).toBe(true);
    expect(x.jobs.map((j) => [j.key, j.seniority])).toEqual([
      ['job:apple:1-1', 'staff'],
      ['job:apple:2-1', 'mid'],
    ]);
  });
});

describe('Google', () => {
  const sitemap = 'https://www.google.com/about/careers/applications/jobs/sitemap.xml';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://careers.google.com/jobs/results/133023244499198662-senior-staff-software-engineer/</loc><lastmod>2026-10-05T11:42:17.337Z</lastmod></url>
    <url><loc>https://careers.google.com/jobs/results/77977290071253702-software-engineer-iii/</loc></url>
    <url><loc>https://careers.google.com/jobs/results/77977290071253702-software-engineer-iii/</loc></url>
    <url><loc>https://careers.google.com/locations/austin/</loc></url></urlset>`;

  it('maps the careers site, old and new hosts, to the jobs sitemap', () => {
    expect(resolveSource('https://careers.google.com/jobs/results/?q=ios')).toEqual({ adapter: 'google', fetchUrl: sitemap });
    expect(resolveSource('https://www.google.com/about/careers/applications/jobs/results?location=Austin')).toEqual({ adapter: 'google', fetchUrl: sitemap });
    expect(resolveSource('https://www.google.com/search?q=jobs').adapter).toBe('html');
  });

  it('reads every job from the sitemap as a partial entry titled from the slug', () => {
    const x = parseGoogleSitemap(xml);
    expect(x.complete).toBe(true);
    expect(x.jobs).toEqual([
      {
        key: 'job:google:133023244499198662',
        title: 'Senior Staff Software Engineer',
        company: 'Google',
        url: 'https://www.google.com/about/careers/applications/jobs/results/133023244499198662-senior-staff-software-engineer',
        source: 'google',
        partial: true,
      },
      {
        key: 'job:google:77977290071253702',
        title: 'Software Engineer III',
        company: 'Google',
        url: 'https://www.google.com/about/careers/applications/jobs/results/77977290071253702-software-engineer-iii',
        source: 'google',
        partial: true,
      },
    ]);
  });
});

describe('Amazon', () => {
  const api = 'https://www.amazon.jobs/en/search.json?offset=0&result_limit=100&sort=recent';
  const loc = (type: string, location: string, normalizedLocation: string) => JSON.stringify({ type, location, normalizedLocation });
  const job = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id: `uuid-${id}`,
    id_icims: id,
    title,
    job_path: `/en/jobs/${id}/${title.toLowerCase().replace(/\W+/g, '-')}`,
    location: 'US, WA, Seattle',
    normalized_location: 'Seattle, Washington, USA',
    locations: [loc('ONSITE', 'US, WA, Seattle', 'Seattle, Washington, USA'), loc('ONSITE', 'US, TX, Austin', 'Austin, Texas, USA')],
    job_category: 'Software Development',
    company_name: 'Amazon Web Services, Inc.',
    posted_date: 'October  6, 2026',
    description: 'Build services that run AWS.',
    basic_qualifications: '- 3+ years of non-internship professional software development experience',
    preferred_qualifications: '- Experience with distributed systems',
    ...extra,
  });
  const page = (hits: number, ...jobs: ReturnType<typeof job>[]) => JSON.stringify({ error: null, hits, jobs });

  it('maps amazon.jobs URLs to the search endpoint', () => {
    expect(resolveSource('https://www.amazon.jobs/en/search?base_query=ios')).toEqual({ adapter: 'amazon', fetchUrl: api });
    expect(resolveSource('https://amazon.jobs/en/jobs/10570004/sde')).toEqual({ adapter: 'amazon', fetchUrl: api });
    expect(resolveSource('https://www.amazon.com/jobs').adapter).toBe('html');
  });

  it('parses postings with every location, the posting date and experience from the qualifications', () => {
    expect(parseAmazonPage(page(1, job('10570004', 'Software Development Engineer'))).jobs).toEqual([
      {
        key: 'job:amazon:10570004',
        title: 'Software Development Engineer',
        location: 'Seattle, Washington, USA',
        other_locations: ['Austin, Texas, USA'],
        department: 'Software Development',
        company: 'Amazon',
        url: 'https://www.amazon.jobs/en/jobs/10570004/software-development-engineer',
        posted_at: '2026-10-06',
        source: 'amazon',
        experience_years: 3,
      },
    ]);
  });

  it('marks a virtual primary location remote and rejects error responses', () => {
    const [v] = parseAmazonPage(
      page(1, job('1', 'Support Advisor', { location: 'IN, TS, Hyderabad - Virtual', normalized_location: 'Hyderabad, Telangana, IND', locations: [loc('VIRTUAL', 'IN, TS, Hyderabad - Virtual', 'Hyderabad, Telangana, IND')] })),
    ).jobs;
    expect(v).toMatchObject({ location: 'Hyderabad, Telangana, IND, Remote', other_locations: undefined });
    expect(() => parseAmazonPage(JSON.stringify({ error: 'Result limit cannot be greater than 100', hits: 0, jobs: null }))).toThrow(/Result limit/);
  });

  it('pages by offset through the newest MAX_JOBS and stays incomplete for a capped hit count', async () => {
    const urls: string[] = [];
    const x = await collectAmazon(page(10000, job('1', 'Role 1')), async (url) => {
      urls.push(url);
      return page(10000, job(String(urls.length + 1), `Role ${urls.length + 1}`));
    });
    expect(urls).toEqual([amazonPageUrl(100), amazonPageUrl(200)].slice(0, AMAZON_MAX_JOBS / 100 - 1));
    expect(x.jobs).toHaveLength(3);
    expect(x.complete).toBe(false);
  });
});

describe('Microsoft', () => {
  const api = 'https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=&location=&start=0&sort_by=timestamp';
  const position = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    id: 1970393557000000 + id,
    displayJobId: String(200000000 + id),
    name,
    locations: ['United States, Washington, Redmond', 'United States, Georgia, Atlanta'],
    standardizedLocations: ['Redmond, WA, US', 'Atlanta, GA, US'],
    postedTs: 1791248905,
    department: 'Software Engineering',
    workLocationOption: 'onsite',
    positionUrl: `/careers/job/${1970393557000000 + id}`,
    ...extra,
  });
  const page = (count: number, ...positions: ReturnType<typeof position>[]) => JSON.stringify({ status: 200, data: { positions, count } });

  it('maps the careers hosts to the search endpoint', () => {
    expect(resolveSource('https://jobs.careers.microsoft.com/global/en/search?q=ios')).toEqual({ adapter: 'microsoft', fetchUrl: api });
    expect(resolveSource('https://apply.careers.microsoft.com/careers/job/1970393557018898')).toEqual({ adapter: 'microsoft', fetchUrl: api });
    expect(resolveSource('https://careers.microsoft.com/')).toEqual({ adapter: 'microsoft', fetchUrl: api });
    expect(resolveSource('https://www.microsoft.com/en-us/').adapter).toBe('html');
  });

  it('parses positions with every location, the posting time and a job link', () => {
    expect(parseMicrosoftPage(page(1, position(58777, 'Principal Software Engineer'))).jobs).toEqual([
      {
        key: 'job:microsoft:200058777',
        title: 'Principal Software Engineer',
        location: 'United States, Washington, Redmond',
        other_locations: ['United States, Georgia, Atlanta'],
        department: 'Software Engineering',
        company: 'Microsoft',
        url: 'https://apply.careers.microsoft.com/careers/job/1970393557058777',
        posted_at: '2026-10-06T01:08:25.000Z',
        source: 'microsoft',
      },
    ]);
    expect(parseMicrosoftPage(page(1, position(1, 'Account Executive', { workLocationOption: 'remote', locations: ['United States'] }))).jobs[0]!.location).toBe('United States, Remote');
  });

  it('pages through the newest MAX_JOBS and keeps what it read when a later page is refused', async () => {
    const urls: string[] = [];
    const full = await collectMicrosoft(page(2379, position(1, 'Role 1')), async (url) => {
      urls.push(url);
      return page(2379, position(urls.length + 1, `Role ${urls.length + 1}`));
    });
    expect(urls).toEqual(Array.from({ length: MS_MAX_JOBS / 10 - 1 }, (_, i) => msPageUrl((i + 1) * 10)));
    expect(full.complete).toBe(false);

    const refused = await collectMicrosoft(page(25, position(1, 'Role 1')), async (url) => {
      if (url === msPageUrl(20)) throw new Error('HTTP 429');
      return page(25, position(2, 'Role 2'));
    });
    expect(refused.jobs.map((j) => j.key)).toEqual(['job:microsoft:200000001', 'job:microsoft:200000002']);
    expect(refused.complete).toBe(false);

    const small = await collectMicrosoft(page(11, position(1, 'Role 1')), async () => page(11, position(2, 'Role 2')));
    expect(small.complete).toBe(true);
  });
});

describe('Oracle Recruiting', () => {
  const origin = 'https://acme.fa.us2.oraclecloud.com';
  const api = oraclePageUrl(origin, 'CX_1001', 0);
  const req = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
    Id: String(210000000 + id),
    Title: title,
    PostedDate: '2026-10-07',
    PrimaryLocation: 'Wilmington, DE, United States',
    JobFamily: 'Software Engineering',
    WorkplaceType: '',
    ShortDescriptionStr: 'You have 5+ years of experience building iOS apps.',
    secondaryLocations: [{ Name: 'Wilmington, DE, United States' }, { Name: 'Plano, TX, United States' }],
    ...extra,
  });
  const page = (total: number, ...reqs: ReturnType<typeof req>[]) => JSON.stringify({ items: [{ TotalJobsCount: total, requisitionList: reqs }] });

  it('maps a candidate experience URL to the site search', () => {
    expect(resolveSource(`${origin}/hcmUI/CandidateExperience/en/sites/CX_1001/job/210704129?utm_source=x`)).toEqual({ adapter: 'oracle', fetchUrl: api });
    expect(resolveSource(`${origin}/hcmUI/CandidateExperience/en/sites/CX_1001`)).toEqual({ adapter: 'oracle', fetchUrl: api });
    expect(resolveSource(api)).toEqual({ adapter: 'oracle', fetchUrl: api });
    expect(resolveSource(`${origin}/fscmUI/faces/FuseWelcome`).adapter).toBe('html');
  });

  it('parses requisitions with every location, the posting date and a job link', () => {
    expect(parseOraclePage(page(1, req(1, 'Software Engineer III - iOS')), api).jobs).toEqual([
      {
        key: 'job:oracle:210000001',
        title: 'Software Engineer III - iOS',
        location: 'Wilmington, DE, United States',
        other_locations: ['Plano, TX, United States'],
        department: 'Software Engineering',
        url: `${origin}/hcmUI/CandidateExperience/en/sites/CX_1001/job/210000001`,
        posted_at: '2026-10-07',
        source: 'oracle',
        experience_years: 5,
      },
    ]);
    expect(parseOraclePage(page(1, req(2, 'Analyst', { WorkplaceType: 'Fully Remote', PrimaryLocation: 'Columbus, OH, United States' })), api).jobs[0]!.location).toBe('Columbus, OH, United States, Remote');
  });

  it('pages through the newest MAX_JOBS', async () => {
    const urls: string[] = [];
    const x = await collectOracle(api, page(7410, req(1, 'Role 1')), async (url) => {
      urls.push(url);
      return page(7410, req(urls.length + 1, `Role ${urls.length + 1}`));
    });
    expect(urls).toEqual([oraclePageUrl(origin, 'CX_1001', 100), oraclePageUrl(origin, 'CX_1001', 200)].slice(0, ORACLE_MAX_JOBS / 100 - 1));
    expect(x.jobs).toHaveLength(3);
    expect(x.complete).toBe(false);
    expect((await collectOracle(api, page(1, req(1, 'Role 1')), async () => page(1))).complete).toBe(true);
  });
});

describe('Eightfold', () => {
  const site = { origin: 'https://acme.eightfold.ai', domain: 'acme.com', source: 'eightfold' as const };
  const api = efPageUrl(site, 0);
  const position = (id: number, name: string) => ({
    id: 481080000000 + id,
    displayJobId: String(260000000 + id),
    name,
    locations: ['Seattle, Washington, United States'],
    postedTs: 1791413813,
    department: 'Technology',
    workLocationOption: 'onsite',
    positionUrl: `/careers/job/${481080000000 + id}`,
  });
  const page = (count: number, ...positions: ReturnType<typeof position>[]) => JSON.stringify({ status: 200, data: { positions, count } });

  it('maps a tenant careers URL to its search, with the domain the jobs are listed under', () => {
    expect(resolveSource('https://acme.eightfold.ai/careers?domain=acme.com&query=ios')).toEqual({ adapter: 'eightfold', fetchUrl: api });
    expect(resolveSource('https://acme.eightfold.ai/careers')).toEqual({ adapter: 'eightfold', fetchUrl: api });
    expect(resolveSource('https://acme.eightfold.ai/careers?domain=acme-coffee.com').fetchUrl).toBe(efPageUrl({ ...site, domain: 'acme-coffee.com' }, 0));
    expect(resolveSource('https://app.eightfold.ai/').adapter).toBe('html');
  });

  it('parses positions and names the company after the tenant', async () => {
    expect(parseEightfoldPage(page(1, position(1, 'principal architect- cloud')), site).jobs[0]).toEqual({
      key: 'job:eightfold:260000001',
      title: 'principal architect- cloud',
      location: 'Seattle, Washington, United States',
      department: 'Technology',
      url: 'https://acme.eightfold.ai/careers/job/481080000001',
      posted_at: '2026-10-07T22:56:53.000Z',
      source: 'eightfold',
    });
    const x = await collect('eightfold', api, { body: page(1, position(1, 'Barista')), contentType: 'application/json', finalUrl: api }, async () => page(1));
    expect(x.jobs[0]!.company).toBe('Acme');
  });

  it('reads the newest MAX_JOBS and keeps what it read when a later page is refused', async () => {
    const urls: string[] = [];
    const full = await collectEightfold(site, page(21417, position(1, 'Role 1')), async (url) => {
      urls.push(url);
      return page(21417, position(urls.length + 1, `Role ${urls.length + 1}`));
    });
    expect(urls).toEqual(Array.from({ length: EF_MAX_JOBS / 10 - 1 }, (_, i) => efPageUrl(site, (i + 1) * 10)));
    expect(full.complete).toBe(false);
    const refused = await collectEightfold(site, page(25, position(1, 'Role 1')), async () => {
      throw new Error('HTTP 429');
    });
    expect(refused.jobs).toHaveLength(1);
    expect(refused.complete).toBe(false);
  });
});

describe('SuccessFactors', () => {
  const origin = 'https://careers.paramount.com';
  const search = sfPageUrl(origin, 0);
  const tile = (id: number, title: string, location: string, date: string) => `
    <li class="job-tile job-id-${id}" data-url="/job/x/${id}/">
      <div class="sub-section sub-section-desktop">
        <a class="jobTitle-link" href="/job/New-York-${encodeURIComponent(title)}-NY-10036/${id}/"> ${title} </a>
        <div id="job-${id}-desktop-section-location-value">${location} </div>
        <div id="job-${id}-desktop-section-date-value">${date} </div>
      </div>
      <div class="sub-section sub-section-tablet">
        <a class="jobTitle-link" href="/job/New-York-${encodeURIComponent(title)}-NY-10036/${id}/"> ${title} </a>
      </div>
    </li>`;
  const tiles = (total: number, ...items: string[]) => `<span id="tile-search-results-label">Showing 1 to 25 of ${total} Jobs</span><ul>${items.join('')}</ul>`;
  const row = (id: number, title: string) => `
    <tr class="data-row">
      <td class="colTitle"><span class="jobTitle hidden-phone"><a href="/ey/job/Boston-${id}/${id}/" class="jobTitle-link">${title}</a></span></td>
      <td class="colLocation"><span class="jobLocation"> Boston, MA, US </span></td>
      <td class="colDate"><span class="jobDate">Sep 30, 2026 </span></td>
    </tr>`;

  it('reads only the hosts it knows', () => {
    expect(resolveSource(`${origin}/job/New-York-Lead-Software-Engineer-NY-10036/1363063100/`)).toEqual({ adapter: 'successfactors', fetchUrl: search });
    expect(resolveSource('https://careers.example.com/search/?q=').adapter).toBe('html');
  });

  it('parses tile and table themes, once per job', () => {
    expect(parseSuccessFactorsPage(tiles(282, tile(1427765000, 'Producer, Newsgathering', 'Studio City, CA, US, 91604', 'Oct 7, 2026')), search)).toEqual({
      total: 282,
      jobs: [
        {
          key: 'job:successfactors:1427765000',
          title: 'Producer, Newsgathering',
          location: 'Studio City, CA, US, 91604',
          company: 'Paramount',
          url: `${origin}/job/New-York-Producer%2C%20Newsgathering-NY-10036/1427765000/`,
          posted_at: '2026-10-07',
          source: 'successfactors',
        },
      ],
    });
    const table = `<span class="paginationLabel">Results <b>1 – 25</b> of <b>1,204</b></span><table>${row(9, 'iOS Engineer')}</table>`;
    const parsed = parseSuccessFactorsPage(table, search);
    expect(parsed.total).toBe(1204);
    expect(parsed.jobs[0]).toMatchObject({ key: 'job:successfactors:9', title: 'iOS Engineer', location: 'Boston, MA, US', posted_at: '2026-09-30' });
  });

  it('pages through the newest MAX_JOBS, and fails on a page that lists none of its jobs', async () => {
    const pageOf = (start: number, size: number) => Array.from({ length: size }, (_, i) => tile(start + i + 1, `Role ${start + i + 1}`, 'NY', 'Oct 7, 2026'));
    const urls: string[] = [];
    const x = await collectSuccessFactors(search, tiles(282, ...pageOf(0, 25)), async (url) => {
      urls.push(url);
      return tiles(282, ...pageOf(Number(new URL(url).searchParams.get('startrow')), 25));
    });
    expect(urls).toEqual(Array.from({ length: SF_MAX_JOBS / 25 - 1 }, (_, i) => sfPageUrl(origin, (i + 1) * 25)));
    expect(x.jobs).toHaveLength(SF_MAX_JOBS);
    expect(x.complete).toBe(false);

    // A site with 10 per page is stepped by 10, within the same number of requests.
    const small: string[] = [];
    await collectSuccessFactors(search, tiles(282, ...pageOf(0, 10)), async (url) => (small.push(url), tiles(282, ...pageOf(Number(new URL(url).searchParams.get('startrow')), 10))));
    expect(small).toEqual(Array.from({ length: SF_MAX_PAGES - 1 }, (_, i) => sfPageUrl(origin, (i + 1) * 10)));
    expect((await collectSuccessFactors(search, tiles(1, ...pageOf(0, 1)), async () => '')).complete).toBe(true);
    await expect(collectSuccessFactors(search, tiles(282), async () => '')).rejects.toThrow();
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
      'https://jobs.apple.com/en-us/details/200668060-0836/senior-leader',
      'https://www.google.com/about/careers/applications/jobs/results',
      'https://www.amazon.jobs/en/search',
      'https://jobs.careers.microsoft.com/global/en/search',
      'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/123',
      'https://acme.eightfold.ai/careers?domain=acme.com&query=ios',
      'https://careers.paramount.com/job/New-York-Lead-Software-Engineer-NY-10036/1363063100/',
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
