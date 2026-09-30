/**
 * Workday career sites ({tenant}.wd{n}.myworkdayjobs.com/{site}, or
 * wd{n}.myworkdaysite.com/recruiting/{tenant}/{site}).
 *
 * The site's own search endpoint is a JSON POST that returns postings newest
 * first, 20 per page, and reports the total only on the first page. Large
 * tenants list thousands of jobs, so a check reads the newest MAX_JOBS and
 * marks the extraction incomplete when there were more: a job leaving that
 * window is not a removal.
 */
import type { Extraction, JobItem } from './types.js';

export const PAGE_SIZE = 20;
export const MAX_JOBS = 200;

const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
const SLUG = /^[\w.-]+$/;

export interface WorkdaySite {
  apiUrl: string;
  /** Prefix for job links: the public site URL without a trailing slash. */
  siteUrl: string;
}

export function resolveWorkday(u: URL): WorkdaySite | null {
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs[0] === 'wday') return null;
  const hosted = /^([\w-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (hosted) {
    const rest = segs[0] && LOCALE.test(segs[0]) ? segs.slice(1) : segs;
    const site = rest[0];
    if (!site || !SLUG.test(site)) return null;
    return { apiUrl: `https://${host}/wday/cxs/${hosted[1]}/${site}/jobs`, siteUrl: `https://${host}/${site}` };
  }
  if (/^wd\d+\.myworkdaysite\.com$/.test(host) && segs[0] === 'recruiting') {
    const [tenant, site] = [segs[1], segs[2]];
    if (!tenant || !site || !SLUG.test(tenant) || !SLUG.test(site)) return null;
    return { apiUrl: `https://${host}/wday/cxs/${tenant}/${site}/jobs`, siteUrl: `https://${host}/recruiting/${tenant}/${site}` };
  }
  return null;
}

/** The public site URL for an API URL (the reverse of resolveWorkday, for job links). */
export function siteUrlFor(apiUrl: string): string {
  const u = new URL(apiUrl);
  const [, , , tenant, site] = u.pathname.split('/'); // /wday/cxs/{tenant}/{site}/jobs
  return /myworkdaysite\.com$/.test(u.hostname) ? `${u.origin}/recruiting/${tenant}/${site}` : `${u.origin}/${site}`;
}

export function pageBody(offset: number): string {
  return JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' });
}

interface Posting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  bulletFields?: string[];
}

export function parseWorkdayPage(body: string, apiUrl: string): { jobs: JobItem[]; total: number } {
  const data = JSON.parse(body) as { total?: number; jobPostings?: Posting[] };
  const siteUrl = siteUrlFor(apiUrl);
  const jobs: JobItem[] = [];
  for (const p of data.jobPostings ?? []) {
    const title = String(p.title ?? '').trim();
    const path = typeof p.externalPath === 'string' ? p.externalPath : undefined;
    if (!title || !path) continue;
    const reqId = p.bulletFields?.find((f) => typeof f === 'string' && f.trim());
    let location = p.locationsText?.trim() || undefined;
    // "3 Locations" hides the list; the path carries the primary one ("/job/US-CA-Santa-Clara/…").
    const n = /^(\d+) Locations$/i.exec(location ?? '');
    if (n) {
      const primary = path.split('/')[2]?.replace(/-/g, ' ');
      location = primary ? `${primary} (+${Number(n[1]) - 1} more)` : location;
    }
    jobs.push({
      key: `job:workday:${(reqId ?? path).toLowerCase()}`,
      title,
      location,
      url: `${siteUrl}${path}`,
      // postedOn is relative ("Posted 3 Days Ago"), so it is not kept.
      source: 'workday',
    });
  }
  return { jobs, total: typeof data.total === 'number' ? data.total : jobs.length };
}

/** Read up to MAX_JOBS newest postings. `post` performs one search request and returns the body. */
export async function collectWorkday(apiUrl: string, firstPage: string, post: (offset: number) => Promise<string>): Promise<Extraction> {
  const first = parseWorkdayPage(firstPage, apiUrl);
  const seen = new Map(first.jobs.map((j) => [j.key, j]));
  const limit = Math.min(first.total, MAX_JOBS);
  for (let offset = PAGE_SIZE; offset < limit; offset += PAGE_SIZE) {
    const page = parseWorkdayPage(await post(offset), apiUrl);
    if (page.jobs.length === 0) break;
    for (const j of page.jobs) seen.set(j.key, j);
  }
  return { jobs: [...seen.values()], complete: first.total <= MAX_JOBS };
}
