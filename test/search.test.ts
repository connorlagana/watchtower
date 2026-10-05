import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { companyFromBoard, extract, primaryRequestUrl } from '../src/extract/adapters.js';
import { htmlToText, jobDetails, parseExperienceYears, parseSalaryText } from '../src/extract/details.js';
import { termMatch } from '../src/extract/match.js';
import type { JobItem } from '../src/extract/types.js';
import { careersPageCandidates, detectBoardLinks, probeTarget, slugCandidates } from '../src/search/discover.js';
import { parseQuery } from '../src/search/query.js';
import { buildFilters, jobMatches } from '../src/services/watches.js';
import { agentPrompt } from '../src/web/site.js';

/** Only the filters the query set, for compact expectations. */
function read(query: string) {
  const { notes: _notes, ...filters } = parseQuery(query);
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
}

describe('parseQuery', () => {
  it('reads role, place, pay and experience from a plain request', () => {
    expect(read('iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience')).toEqual({
      keywords: ['ios'],
      locations: ['austin'],
      min_salary: 150_000,
      max_experience_years: 6,
    });
  });

  it('reads levels, remote, currencies and hourly pay', () => {
    expect(read('senior backend engineer roles in New York or remote paying $180,000+')).toEqual({
      keywords: ['backend'],
      locations: ['new york', 'remote'],
      seniority: ['senior'],
      min_salary: 180_000,
      salary_currency: 'USD',
    });
    expect(read('entry level react developer remote $45/hr')).toEqual({ keywords: ['react'], seniority: ['entry'], remote_only: true, min_salary: 93_600, salary_currency: 'USD' });
    expect(read('product designer jobs in London, no managers, £70k+')).toEqual({
      all_keywords: ['product', 'designer'],
      exclude_keywords: ['manager'],
      locations: ['london'],
      min_salary: 70_000,
      salary_currency: 'GBP',
    });
  });

  it('treats "or" as any-of, several role words as all-of, and a state as part of the city', () => {
    expect(read('iOS or Android developer in Austin, TX')).toEqual({ keywords: ['ios', 'android'], locations: ['austin'] });
    expect(read('remote machine learning engineer jobs, 3-5 years experience')).toEqual({ all_keywords: ['machine', 'learning'], remote_only: true, max_experience_years: 5 });
    expect(read('software engineer jobs in Seattle')).toEqual({ keywords: ['software engineer'], locations: ['seattle'] });
  });

  it("takes the searcher's own experience as the most a job may ask for, and expands common place names", () => {
    expect(read('I have 4 years of experience and want golang roles in SF or NYC making over 160k')).toEqual({
      keywords: ['golang'],
      locations: ['san francisco', 'sf', 'new york', 'nyc'],
      max_experience_years: 4,
      min_salary: 160_000,
    });
  });

  it('says what it could not use', () => {
    const parsed = parseQuery('python jobs under $200k in Berlin');
    expect(parsed).toMatchObject({ keywords: ['python'], locations: ['berlin'] });
    expect(parsed.min_salary).toBeUndefined();
    expect(parsed.notes[0]).toMatch(/maximum salary/);
  });

  it('reads a request pasted whole into an agent, and a state written without a comma', () => {
    expect(read('hey use watchtower.lat to find new ios roles for at least 150k under 6 years of experience in austin texas')).toEqual({
      keywords: ['ios'],
      locations: ['austin'],
      min_salary: 150_000,
      max_experience_years: 6,
    });
    expect(read('senior react engineer roles in seattle wa')).toEqual({ keywords: ['react'], locations: ['seattle'], seniority: ['senior'] });
    expect(read('roles in albany new york')).toEqual({ locations: ['albany'] });
    expect(read('designer roles in new york')).toEqual({ keywords: ['designer'], locations: ['new york'] });
    expect(read('node.js roles in kansas city')).toEqual({ keywords: ['node.js'], locations: ['kansas city'] });
    // A question about what is open now: the asking words are not role words.
    expect(read('can you show the current jobs for iOS in Austin for max 6 years of experience')).toEqual({ keywords: ['ios'], locations: ['austin'], max_experience_years: 6 });
    expect(read("what's open right now for staff data engineers in Denver?")).toEqual({ keywords: ['data'], locations: ['denver'], seniority: ['staff'] });
  });

  it('reads every prompt the homepage quiz builds back into the choices that built it', () => {
    const roleSets: [string[], Record<string, string[]>][] = [
      [['iOS'], { keywords: ['ios'] }],
      [['iOS', 'Android'], { keywords: ['ios', 'android'] }],
      [['Machine learning', 'Product design'], { keywords: ['machine learning', 'product design'] }],
      [['Machine learning'], { all_keywords: ['machine', 'learning'] }],
    ];
    const placeSets: [string[], Record<string, unknown>][] = [
      [[], {}],
      [['Austin, TX'], { locations: ['austin'] }],
      [['Remote'], { remote_only: true }],
      [['Austin, TX', 'Remote'], { locations: ['austin', 'remote'] }],
      [['San Francisco, CA', 'New York, NY'], { locations: ['san francisco', 'new york'] }],
    ];
    for (const [roles, roleWant] of roleSets)
      for (const [locations, placeWant] of placeSets)
        for (const salaryK of [0, 150])
          for (const years of [0, 1, 6]) {
            const prompt = agentPrompt('watchtower.lat', 'https://watchtower.lat/llms.txt', { roles, locations, salaryK, years });
            const want: Record<string, unknown> = { ...roleWant, ...placeWant };
            if (salaryK) Object.assign(want, { min_salary: salaryK * 1000, salary_currency: 'USD' });
            if (years) want.max_experience_years = years;
            expect(read(prompt), prompt).toEqual(want);
          }
  });

  it('widens a city to its metro area when asked, and keeps every area the quiz offers', () => {
    const areas = { 'the SF Bay Area': 'palo alto', 'the NYC metro area': 'jersey city', 'the Greater Austin area': 'round rock', 'the Greater Seattle area': 'bellevue', 'Greater Boston': 'cambridge', 'Greater Los Angeles': 'santa monica', Chicagoland: 'evanston', 'the Denver metro area': 'boulder' };
    for (const [area, town] of Object.entries(areas)) {
      const { locations } = parseQuery(agentPrompt('watchtower.lat', 'https://watchtower.lat/llms.txt', { roles: ['iOS'], locations: [area, 'Remote'], salaryK: 0, years: 0 }));
      expect(locations, area).toContain(town);
      expect(locations, area).toContain('remote');
    }
    expect(read('iOS roles in the Austin area')).toMatchObject({ locations: ['austin', 'round rock', 'cedar park', 'pflugerville', 'leander', 'san marcos'] });
    expect(read('iOS roles in Austin')).toMatchObject({ locations: ['austin'] });
  });

  it('never throws', () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (q) => void parseQuery(q)));
  });
});

describe('buildFilters', () => {
  it('lets explicit filters replace what the query said', () => {
    const { filters, query } = buildFilters({ query: '  iOS jobs in Austin making at least 150k ', locations: ['Dallas'], all_keywords: ['Swift', 'iOS'], include_unknown: false });
    expect(query).toBe('iOS jobs in Austin making at least 150k');
    expect(filters).toMatchObject({ keywords: [], all_keywords: ['swift', 'ios'], locations: ['dallas'], min_salary: 150_000, include_unknown: false });
  });
});

describe('term matching', () => {
  it('matches whole words, with plurals, and never inside another word', () => {
    expect(termMatch('senior ios engineer', 'ios')).toBe(true);
    expect(termMatch('producer, game studios', 'ios')).toBe(false);
    expect(termMatch('javascript developer', 'java')).toBe(false);
    expect(termMatch('backend engineers', 'engineer')).toBe(true);
    expect(termMatch('c++ engineer', 'c++')).toBe(true);
    expect(termMatch('.net developer', '.net')).toBe(true);
    expect(termMatch('new york, ny', 'new york')).toBe(true);
  });
});

describe('pay and experience from posting text', () => {
  it('reads pay ranges and ignores other money', () => {
    expect(parseSalaryText('Salary: $193,232 - 288,000/yr. This range')).toMatchObject({ min: 193_232, max: 288_000, currency: 'USD', period: 'year' });
    expect(parseSalaryText('$150K–$200K USD')).toMatchObject({ min: 150_000, max: 200_000 });
    expect(parseSalaryText('$150-200k')).toMatchObject({ min: 150_000, max: 200_000 });
    expect(parseSalaryText('£60,000 - £80,000 per annum')).toMatchObject({ currency: 'GBP', annual_max: 80_000 });
    expect(parseSalaryText('pay is $45 - $60 per hour')).toMatchObject({ period: 'hour', annual_min: 93_600, annual_max: 124_800 });
    expect(parseSalaryText('base salary of $150,000 plus equity')).toMatchObject({ min: 150_000, annual_min: 150_000 });
    expect(parseSalaryText('Zone A: $150,000 - $200,000. Zone B: $135,000 - $180,000')).toMatchObject({ min: 135_000, max: 200_000 });
    expect(parseSalaryText('businesses processing $20M–$50M in annual payment volume')).toBeUndefined();
    expect(parseSalaryText('a $10,000 sign-on bonus and $5 - $10 off lunch')).toBeUndefined();
  });

  it('reads the years a posting asks for, not other durations', () => {
    expect(parseExperienceYears('Minimum requirements 5+ years of experience conducting incident response')).toBe(5);
    expect(parseExperienceYears('5–8 years of full sales cycle or account management experience')).toBe(5);
    expect(parseExperienceYears('Experience: 7+ years')).toBe(7);
    expect(parseExperienceYears('three years of experience')).toBe(3);
    expect(parseExperienceYears('vesting over 4 years. You have 6+ years in backend engineering')).toBe(6);
    expect(parseExperienceYears('For over 20 years we have built tools. Founded 10 years ago.')).toBeUndefined();
  });

  it('unescapes Greenhouse-style escaped HTML', () => {
    expect(htmlToText('&lt;p&gt;Pay &amp;amp; perks: &lt;b&gt;$100,000&lt;/b&gt;&amp;nbsp;- $120,000&lt;/p&gt;')).toBe('Pay & perks: $100,000 - $120,000');
  });

  it('never throws', () => {
    fc.assert(fc.property(fc.array(fc.oneof(fc.string(), fc.constant('$150k - $200,000 per hour 5+ years of experience'), fc.anything())), (parts) => void jobDetails(parts)));
  });
});

describe('adapters carry pay, experience, company and extra locations', () => {
  it('asks listing APIs for posting text and pay in the same request', () => {
    expect(primaryRequestUrl('greenhouse', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs')).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true&pay_transparency=true');
    expect(primaryRequestUrl('ashby', 'https://api.ashbyhq.com/posting-api/job-board/acme')).toBe('https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true');
    expect(primaryRequestUrl('lever', 'https://api.lever.co/v0/postings/acme?mode=json')).toBe('https://api.lever.co/v0/postings/acme?mode=json');
    expect(companyFromBoard('lever', 'https://api.lever.co/v0/postings/acme-robotics?mode=json')).toBe('Acme Robotics');
    expect(companyFromBoard('html', 'https://example.com/careers')).toBeUndefined();
  });

  it('Greenhouse: escaped content and pay ranges', () => {
    const body = JSON.stringify({
      jobs: [
        { id: 1, title: 'iOS Engineer', company_name: 'Acme', location: { name: 'Austin, TX' }, content: '&lt;p&gt;5+ years of experience. Salary: $160,000 - $190,000/yr&lt;/p&gt;' },
        { id: 2, title: 'Designer', location: { name: 'Remote' }, pay_input_ranges: [{ min_cents: 12_000_000, max_cents: 15_000_000, currency_type: 'USD', title: 'Annual Salary' }] },
      ],
    });
    const [ios, designer] = extract('greenhouse', body, 'application/json').jobs;
    expect(ios).toMatchObject({ company: 'Acme', experience_years: 5, salary: { min: 160_000, max: 190_000, currency: 'USD' } });
    expect(designer!.salary).toMatchObject({ min: 120_000, max: 150_000, period: 'year' });
    expect(designer!.experience_years).toBeUndefined();
  });

  it('Lever and Ashby: structured pay and every location', () => {
    const lever = extract(
      'lever',
      JSON.stringify([
        { id: 'x', text: 'iOS Engineer', categories: { location: 'Austin, TX', allLocations: ['Austin, TX', 'Denver, CO'] }, salaryRange: { min: 150_000, max: 180_000, currency: 'USD', interval: 'per-year-salary' }, descriptionPlain: 'We want 3+ years of experience.' },
      ]),
      'application/json',
    ).jobs[0];
    expect(lever).toMatchObject({ other_locations: ['Denver, CO'], experience_years: 3, salary: { annual_min: 150_000, annual_max: 180_000 } });
    const ashby = extract(
      'ashby',
      JSON.stringify({
        jobs: [
          {
            id: 'y',
            title: 'iOS Engineer',
            location: 'New York',
            secondaryLocations: [{ location: 'Austin, TX' }],
            compensation: { summaryComponents: [{ compensationType: 'EquityPercentage' }, { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 189_000, maxValue: 330_000 }] },
          },
        ],
      }),
      'application/json',
    ).jobs[0];
    expect(ashby).toMatchObject({ other_locations: ['Austin, TX'], salary: { min: 189_000, max: 330_000, currency: 'USD' } });
  });
});

describe('jobMatches', () => {
  const filters = buildFilters({ query: 'iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience' }).filters;
  const job = (over: Partial<JobItem>): JobItem => ({ key: 'k', title: 'iOS Engineer', location: 'Austin, TX', source: 'greenhouse', ...over });
  const pay = (min: number, max: number, currency = 'USD') => ({ min, max, currency, period: 'year' as const, annual_min: min, annual_max: max });

  it('compares the top of the pay range and the years asked for', () => {
    expect(jobMatches(job({ salary: pay(140_000, 170_000), experience_years: 5 }), filters)).toBe(true);
    expect(jobMatches(job({ salary: pay(100_000, 140_000), experience_years: 5 }), filters)).toBe(false);
    expect(jobMatches(job({ salary: pay(160_000, 200_000), experience_years: 8 }), filters)).toBe(false);
    expect(jobMatches(job({ location: 'New York', other_locations: ['Austin, TX'], salary: pay(160_000, 200_000) }), filters)).toBe(true);
    expect(jobMatches(job({ location: 'Houston' }), filters)).toBe(false);
    expect(jobMatches(job({ title: 'Producer, Game Studios' }), filters)).toBe(false);
  });

  it('keeps jobs that state neither unless include_unknown is off, and respects the currency', () => {
    expect(jobMatches(job({}), filters)).toBe(true);
    expect(jobMatches(job({}), { ...filters, include_unknown: false })).toBe(false);
    expect(jobMatches(job({ salary: pay(160_000, 200_000, 'CAD') }), { ...filters, salary_currency: 'USD' })).toBe(false);
  });
});

describe('board discovery', () => {
  it('finds the boards a careers page links to or embeds, most-mentioned first', () => {
    const html = `
      <a href="https://jobs.ashbyhq.com/acme/1234-abcd">Senior Engineer</a> <a href="https://jobs.ashbyhq.com/acme/5678">Designer</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmecorp"></script>
      <a href="https://jobs.lever.co/acme-labs/9f1c">Apply</a>
      <a href="https://apply.workable.com/j/ABC123">one job, not a board</a>
      <iframe src="https://acme.wd5.myworkdayjobs.com/en-US/Careers"></iframe>
      <a href="https://www.linkedin.com/company/acme/jobs">LinkedIn</a>`;
    expect(detectBoardLinks(html)).toEqual([
      'https://jobs.ashbyhq.com/acme',
      'https://boards.greenhouse.io/acmecorp',
      'https://jobs.lever.co/acme-labs',
      'https://acme.wd5.myworkdayjobs.com/Careers',
    ]);
    expect(detectBoardLinks('<html><body>We are hiring! Email jobs@acme.com</body></html>')).toEqual([]);
  });

  it('guesses board names from the domain and the company name, skipping ones too short to be distinctive', () => {
    expect(slugCandidates('Acme Robotics, Inc.', 'https://www.getacme.io/about')).toEqual(['getacme', 'acmerobotics', 'acme-robotics']);
    expect(slugCandidates('Zed', 'https://zed.dev')).toEqual([]);
    expect(slugCandidates('Café Société', undefined)).toEqual(['cafesociete', 'cafe-societe']);
    expect(careersPageCandidates('http://acme.com/landing?x=1')).toEqual(['https://acme.com/careers', 'https://acme.com/jobs', 'https://acme.com']);
    expect(careersPageCandidates('not a url')).toEqual([]);
  });

  it('maps a board URL to the platform and name to confirm', () => {
    expect(probeTarget('https://jobs.ashbyhq.com/acme')).toEqual({ platform: 'ashby', slug: 'acme' });
    expect(probeTarget('https://job-boards.greenhouse.io/acme/jobs/1')).toEqual({ platform: 'greenhouse', slug: 'acme' });
    expect(probeTarget('https://acme.wd5.myworkdayjobs.com/Careers')).toBeNull();
    expect(probeTarget('https://example.com/careers')).toBeNull();
  });

  it('never throws', () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 60 }), (html, name) => void [detectBoardLinks(html), slugCandidates(name, html), careersPageCandidates(html)]));
  });
});
