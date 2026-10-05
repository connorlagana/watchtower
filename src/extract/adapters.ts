/**
 * Source adapters. A watch on a Greenhouse, Lever, Ashby, Workable,
 * SmartRecruiters or Recruitee board is fetched through that platform's
 * public job-board JSON API instead of scraping the HTML. Workday and iCIMS
 * sites need more than one request per check (see workday.ts / icims.ts).
 * Any other careers page is read through its schema.org JobPosting markup.
 */
import { classify } from './classify.js';
import { jobDetails, makeSalary, periodOf } from './details.js';
import { extractHtml } from './html.js';
import { collectIcims, resolveIcims, searchUrlFor } from './icims.js';
import { extractJsonLd, parseJsonLdBlocks } from './jsonld.js';
import type { AdapterName, Extraction, JobItem, Salary } from './types.js';
import { collectWorkday, pageBody, resolveWorkday, siteUrlFor } from './workday.js';

export interface ResolvedSource {
  adapter: AdapterName;
  /** The URL Watchtower actually fetches. */
  fetchUrl: string;
}

/** Query parameters that only track the visitor and never change page content. */
const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|yclid|twclid|ttclid|li_fat_id|_ga|_gl|ref_src)$/i;

/**
 * Canonicalize a URL so equivalent URLs share one resource: lowercase host,
 * drop fragment, default port and tracking parameters, and sort the query.
 */
export function canonicalUrl(input: string): string {
  const u = new URL(input);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  params.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  u.search = params.length ? new URLSearchParams(params).toString() : '';
  return u.toString();
}

const SLUG = /^[\w.-]+$/;

export function resolveSource(input: string): ResolvedSource {
  const u = new URL(input);
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  // boards.greenhouse.io/{token}, job-boards.greenhouse.io/{token}, boards.greenhouse.io/embed/job_board?for={token}
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    const token = segs[0] === 'embed' ? u.searchParams.get('for') : segs[0];
    if (token && /^[\w-]+$/.test(token)) {
      const api = host.includes('.eu.') ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
      return { adapter: 'greenhouse', fetchUrl: `https://${api}/v1/boards/${token}/jobs` };
    }
  }
  if (/^boards-api(\.eu)?\.greenhouse\.io$/.test(host) && segs[0] === 'v1' && segs[1] === 'boards' && segs[2]) {
    return { adapter: 'greenhouse', fetchUrl: `https://${host}/v1/boards/${segs[2]}/jobs` };
  }
  // jobs.lever.co/{company}
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && segs[0] && /^[\w-]+$/.test(segs[0])) {
    const api = host.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
    return { adapter: 'lever', fetchUrl: `https://${api}/v0/postings/${segs[0]}?mode=json` };
  }
  if (/^api(\.eu)?\.lever\.co$/.test(host) && segs[0] === 'v0' && segs[1] === 'postings' && segs[2]) {
    return { adapter: 'lever', fetchUrl: `https://${host}/v0/postings/${segs[2]}?mode=json` };
  }
  // jobs.ashbyhq.com/{org}
  if (host === 'jobs.ashbyhq.com' && segs[0] && SLUG.test(segs[0])) {
    return { adapter: 'ashby', fetchUrl: `https://api.ashbyhq.com/posting-api/job-board/${segs[0]}` };
  }
  // apply.workable.com/{account} or {account}.workable.com
  const workable = host === 'apply.workable.com' ? segs[0] : /^([\w-]+)\.workable\.com$/.exec(host)?.[1];
  if (workable && SLUG.test(workable) && !['www', 'apply', 'jobs'].includes(workable)) {
    return { adapter: 'workable', fetchUrl: `https://apply.workable.com/api/v1/widget/accounts/${workable}` };
  }
  // jobs.smartrecruiters.com/{company} or careers.smartrecruiters.com/{company}
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && segs[0] && SLUG.test(segs[0])) {
    return { adapter: 'smartrecruiters', fetchUrl: `https://api.smartrecruiters.com/v1/companies/${segs[0]}/postings?limit=100` };
  }
  // {company}.recruitee.com
  const recruitee = /^([\w-]+)\.recruitee\.com$/.exec(host)?.[1];
  if (recruitee && recruitee !== 'www') {
    return { adapter: 'recruitee', fetchUrl: `https://${recruitee}.recruitee.com/api/offers/` };
  }
  const workday = resolveWorkday(u);
  if (workday) return { adapter: 'workday', fetchUrl: workday.apiUrl };
  const icims = resolveIcims(u);
  if (icims) return { adapter: 'icims', fetchUrl: icims.sitemapUrl };
  return { adapter: 'html', fetchUrl: canonicalUrl(input) };
}

/** Adapters whose first request is a JSON POST rather than a GET. */
export function primaryRequestBody(adapter: AdapterName): string | undefined {
  return adapter === 'workday' ? pageBody(0) : undefined;
}

/**
 * The URL actually requested for a resource. Listing APIs that can include the
 * posting text and pay range in the same response are asked to, so salary and
 * experience are known without a request per job. The resource URL (its
 * identity) stays the plain listing URL.
 */
export function primaryRequestUrl(adapter: AdapterName, fetchUrl: string): string {
  const withParams = (params: string) => `${fetchUrl}${fetchUrl.includes('?') ? '&' : '?'}${params}`;
  if (adapter === 'greenhouse') return withParams('content=true&pay_transparency=true');
  if (adapter === 'ashby') return withParams('includeCompensation=true');
  if (adapter === 'workable') return withParams('details=true');
  return fetchUrl;
}

/** Adapters that need more than one request per check, and how many at most. */
export function requestsPerCheck(adapter: AdapterName): number {
  if (adapter === 'workday') return 10;
  if (adapter === 'icims') return 2;
  return 1;
}

type Rec = Record<string, unknown>;
const s_ = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const joinParts = (...parts: unknown[]) => parts.map(s_).filter(Boolean).join(', ') || undefined;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** Further locations, without repeats of the primary one. */
const others = (primary: string | undefined, all: unknown[]): string[] | undefined => {
  const list = [...new Set(all.map(s_).filter((x): x is string => !!x && x !== primary))].slice(0, 20);
  return list.length ? list : undefined;
};

/** Greenhouse pay-transparency ranges: [{ min_cents, max_cents, currency_type, title }]. */
function greenhousePay(v: unknown): Salary | undefined {
  const r = Array.isArray(v) ? (v[0] as Rec | undefined) : undefined;
  const min = num(r?.min_cents);
  const max = num(r?.max_cents);
  if (!r || (min === undefined && max === undefined)) return undefined;
  const top = (max ?? min!) / 100;
  return makeSalary(min === undefined ? undefined : min / 100, max === undefined ? undefined : max / 100, periodOf(r.title) ?? (top >= 10_000 ? 'year' : 'hour'), s_(r.currency_type));
}

function greenhouse(body: string): Extraction {
  const data = JSON.parse(body) as { jobs?: Record<string, unknown>[] };
  const jobs: JobItem[] = (data.jobs ?? []).map((j) => {
    const depts = (j.departments as { name?: string }[] | undefined)?.map((d) => d.name).filter(Boolean);
    const title = String(j.title ?? '').trim();
    return {
      key: `job:greenhouse:${j.id}`,
      title,
      location: (j.location as { name?: string } | undefined)?.name?.trim() || undefined,
      department: depts?.length ? depts.join(', ') : undefined,
      company: s_(j.company_name),
      url: typeof j.absolute_url === 'string' ? j.absolute_url : undefined,
      posted_at: typeof j.first_published === 'string' ? j.first_published : undefined,
      source: 'greenhouse',
      ...jobDetails([title, j.content], greenhousePay(j.pay_input_ranges)),
    };
  });
  return { jobs };
}

function lever(body: string): Extraction {
  const data = JSON.parse(body) as Record<string, unknown>[];
  if (!Array.isArray(data)) throw new Error('unexpected Lever response');
  const jobs: JobItem[] = data.map((j) => {
    const cat = (j.categories ?? {}) as Record<string, unknown>;
    const title = String(j.text ?? '').trim();
    const location = typeof cat.location === 'string' ? cat.location : undefined;
    const pay = j.salaryRange as Rec | undefined;
    const lists = Array.isArray(j.lists) ? (j.lists as Rec[]).flatMap((l) => [l.text, l.content]) : [];
    return {
      key: `job:lever:${j.id}`,
      title,
      location,
      other_locations: others(location, Array.isArray(cat.allLocations) ? cat.allLocations : []),
      ...jobDetails(
        [title, j.descriptionPlain, ...lists, j.additionalPlain, j.salaryDescriptionPlain],
        pay ? makeSalary(num(pay.min), num(pay.max), periodOf(pay.interval) ?? 'year', s_(pay.currency)) : undefined,
      ),
      department: [cat.team, cat.commitment].filter((x) => typeof x === 'string').join(', ') || undefined,
      url: typeof j.hostedUrl === 'string' ? j.hostedUrl : undefined,
      posted_at: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : undefined,
      source: 'lever',
    };
  });
  return { jobs };
}

/** Ashby compensation (includeCompensation=true): the salary component of the summary. */
function ashbyPay(v: unknown): Salary | undefined {
  const parts = (v as { summaryComponents?: Rec[] } | undefined)?.summaryComponents;
  const pay = Array.isArray(parts) ? parts.find((c) => c.compensationType === 'Salary' && (num(c.minValue) !== undefined || num(c.maxValue) !== undefined)) : undefined;
  return pay ? makeSalary(num(pay.minValue), num(pay.maxValue), periodOf(pay.interval) ?? 'year', s_(pay.currencyCode)) : undefined;
}

function ashby(body: string): Extraction {
  const data = JSON.parse(body) as { jobs?: Rec[] };
  const jobs: JobItem[] = (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      key: `job:ashby:${j.id}`,
      title: String(j.title ?? '').trim(),
      location: joinParts(j.location, j.isRemote === true ? 'Remote' : undefined),
      other_locations: others(s_(j.location), Array.isArray(j.secondaryLocations) ? (j.secondaryLocations as Rec[]).map((l) => l?.location) : []),
      ...jobDetails([j.title, j.descriptionPlain ?? j.descriptionHtml], ashbyPay(j.compensation)),
      department: joinParts(j.department, j.team),
      url: s_(j.jobUrl),
      posted_at: s_(j.publishedAt),
      source: 'ashby' as const,
    }));
  return { jobs };
}

function workable(body: string): Extraction {
  const data = JSON.parse(body) as { name?: string; jobs?: Rec[] };
  const jobs: JobItem[] = (data.jobs ?? []).map((j) => ({
    key: `job:workable:${j.shortcode ?? j.id ?? j.url}`,
    title: String(j.title ?? '').trim(),
    location: joinParts(j.city, j.state, j.country, j.telecommuting === true ? 'Remote' : undefined),
    other_locations: others(joinParts(j.city, j.state, j.country), Array.isArray(j.locations) ? (j.locations as Rec[]).map((l) => joinParts(l?.city, l?.region, l?.country)) : []),
    ...jobDetails([j.title, j.description, j.requirements, j.benefits]),
    department: s_(j.department),
    company: s_(data.name),
    url: s_(j.url) ?? s_(j.application_url),
    posted_at: s_(j.published_on) ?? s_(j.created_at),
    source: 'workable' as const,
  }));
  return { jobs };
}

function smartrecruiters(body: string, fetchUrl?: string): Extraction {
  const data = JSON.parse(body) as { content?: Rec[] };
  const company = fetchUrl ? /companies\/([^/]+)/.exec(fetchUrl)?.[1] : undefined;
  const jobs: JobItem[] = (data.content ?? []).map((j) => {
    const loc = (j.location ?? {}) as Rec;
    return {
      key: `job:smartrecruiters:${j.id}`,
      title: String(j.name ?? '').trim(),
      location: joinParts(loc.city, loc.region, loc.country, loc.remote === true ? 'Remote' : undefined),
      department: s_((j.department as Rec | undefined)?.label),
      company: s_((j.company as Rec | undefined)?.name),
      url: company ? `https://jobs.smartrecruiters.com/${company}/${j.id}` : undefined,
      posted_at: s_(j.releasedDate),
      source: 'smartrecruiters' as const,
    };
  });
  return { jobs };
}

function recruiteePay(v: unknown): Salary | undefined {
  const pay = v as Rec | null | undefined;
  if (!pay || (num(pay.min) === undefined && num(pay.max) === undefined)) return undefined;
  return makeSalary(num(pay.min), num(pay.max), periodOf(pay.period) ?? 'year', s_(pay.currency));
}

function recruitee(body: string): Extraction {
  const data = JSON.parse(body) as { offers?: Rec[] };
  const jobs: JobItem[] = (data.offers ?? []).map((j) => ({
    key: `job:recruitee:${j.id}`,
    title: String(j.title ?? '').trim(),
    ...jobDetails([j.title, j.description, j.requirements], recruiteePay(j.salary)),
    location: s_(j.location) ?? joinParts(j.city, j.country, j.remote === true ? 'Remote' : undefined),
    department: s_(j.department),
    company: s_(j.company_name),
    url: s_(j.careers_url),
    posted_at: s_(j.published_at),
    source: 'recruitee' as const,
  }));
  return { jobs };
}

function extractOne(adapter: AdapterName, body: string, contentType: string, opts: { baseUrl?: string }): Extraction {
  if (adapter === 'greenhouse') return greenhouse(body);
  if (adapter === 'lever') return lever(body);
  if (adapter === 'ashby') return ashby(body);
  if (adapter === 'workable') return workable(body);
  if (adapter === 'smartrecruiters') return smartrecruiters(body, opts.baseUrl);
  if (adapter === 'recruitee') return recruitee(body);

  const ct = contentType.toLowerCase();
  if (ct.includes('ld+json')) return extractJsonLd(parseJsonLdBlocks([body]), opts.baseUrl);
  if (ct.includes('html') || (!ct && /^\s*<(!doctype|html|head|body)/i.test(body))) return extractHtml(body, opts);
  return { jobs: [] };
}

const finalize = (x: Extraction): Extraction => ({ complete: true, ...x, jobs: classify(x.jobs) });

const BOARD_SLUG: Partial<Record<AdapterName, RegExp>> = {
  greenhouse: /\/v1\/boards\/([^/?]+)/,
  lever: /\/v0\/postings\/([^/?]+)/,
  ashby: /\/job-board\/([^/?]+)/,
  workable: /\/accounts\/([^/?]+)/,
  smartrecruiters: /\/companies\/([^/?]+)/,
  recruitee: /^https:\/\/([^./]+)\.recruitee\.com/,
  workday: /\/wday\/cxs\/([^/?]+)/,
  icims: /^https:\/\/(?:careers-)?([^./]+)\.icims\.com/,
};

/** A readable company name from the board's slug ("acme-robotics" → "Acme Robotics"), for sources that do not name the company. */
export function companyFromBoard(adapter: AdapterName, fetchUrl: string): string | undefined {
  const slug = BOARD_SLUG[adapter]?.exec(fetchUrl)?.[1];
  if (!slug) return undefined;
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    /* keep the raw slug */
  }
  return text.replace(/[-_.]+/g, ' ').trim().replace(/\b[a-z]/g, (c) => c.toUpperCase()) || undefined;
}

/** The public page of a board, from the URL it is fetched from: the address a person opens, and that watch_jobs accepts as url. */
export function boardPageUrl(adapter: AdapterName, fetchUrl: string): string {
  const slug = BOARD_SLUG[adapter]?.exec(fetchUrl)?.[1];
  const eu = /\.eu\./.test(new URL(fetchUrl).hostname);
  switch (adapter) {
    case 'greenhouse':
      return `https://job-boards${eu ? '.eu' : ''}.greenhouse.io/${slug}`;
    case 'lever':
      return `https://jobs${eu ? '.eu' : ''}.lever.co/${slug}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${slug}`;
    case 'workable':
      return `https://apply.workable.com/${slug}`;
    case 'smartrecruiters':
      return `https://jobs.smartrecruiters.com/${slug}`;
    case 'recruitee':
      return `https://${slug}.recruitee.com/`;
    case 'workday':
      return siteUrlFor(fetchUrl);
    case 'icims':
      return `${new URL(fetchUrl).origin}/jobs`;
    default:
      return fetchUrl;
  }
}

/** Results across many boards are only useful when each job says whose it is. */
function withCompany(x: Extraction, adapter: AdapterName, fetchUrl: string): Extraction {
  const company = companyFromBoard(adapter, fetchUrl);
  return company ? { ...x, jobs: x.jobs.map((j) => (j.company ? j : { ...j, company })) } : x;
}

/** Extract jobs from a single response (every adapter except Workday and iCIMS). */
export function extract(adapter: AdapterName, body: string, contentType: string, opts: { baseUrl?: string } = {}): Extraction {
  return finalize(extractOne(adapter, body, contentType, opts));
}

export interface MoreRequests {
  /** Fetch another URL of the same source; throws on any failure. */
  (url: string, jsonBody?: string): Promise<string>;
}

/**
 * Extract jobs from the primary response, making follow-up requests through
 * `more` for adapters that need them.
 */
export async function collect(adapter: AdapterName, fetchUrl: string, primary: { body: string; contentType: string; finalUrl: string }, more: MoreRequests): Promise<Extraction> {
  if (adapter === 'workday') return withCompany(finalize(await collectWorkday(fetchUrl, primary.body, (offset) => more(fetchUrl, pageBody(offset)))), adapter, fetchUrl);
  if (adapter === 'icims') {
    // The search page is an enrichment: a failure there still leaves a complete job list.
    const search = await more(searchUrlFor(fetchUrl)).catch(() => null);
    return withCompany(finalize(collectIcims(primary.body, search)), adapter, fetchUrl);
  }
  return withCompany(extract(adapter, primary.body, primary.contentType, { baseUrl: primary.finalUrl }), adapter, fetchUrl);
}
