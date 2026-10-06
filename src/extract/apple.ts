/**
 * Apple's own careers site (jobs.apple.com).
 *
 * The site's search endpoint (/api/v1/search) is a JSON POST that returns
 * postings newest first, 20 per page, with the total. It needs no session.
 * Apple lists thousands of roles, so a check reads the newest MAX_JOBS and
 * marks the extraction incomplete, as for Workday.
 *
 * About 80 evergreen retail roles ("PIPE-…", one per country and store role)
 * are stamped with the time of the request, so they always sort first and
 * take that much of the window. Their timestamp is not a posting date and is
 * not kept.
 */
import { jobDetails } from './details.js';
import type { Extraction, JobItem } from './types.js';

export const API_URL = 'https://jobs.apple.com/api/v1/search';
export const SITE_URL = 'https://jobs.apple.com/en-us/search';
export const PAGE_SIZE = 20;
export const MAX_JOBS = 300;

export function resolveApple(u: URL): { apiUrl: string } | null {
  return u.hostname.toLowerCase() === 'jobs.apple.com' ? { apiUrl: API_URL } : null;
}

/** Search request for a 1-based page. */
export function pageBody(page: number): string {
  return JSON.stringify({ query: '', filters: {}, page, locale: 'en-us', sort: 'newest', format: { longDate: 'MMMM D, YYYY', mediumDate: 'MMM D, YYYY' } });
}

type Rec = Record<string, unknown>;
const s_ = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** "Cupertino, United States of America"; a country-level location is just the country. */
function place(l: Rec): string | undefined {
  const name = s_(l.name);
  const country = s_(l.countryName);
  return name && country && name !== country ? `${name}, ${country}` : (name ?? country);
}

/** A posting date with more than millisecond precision is the request time on an evergreen role. */
const postedAt = (v: unknown) => {
  const d = s_(v);
  return d && !/\.\d{4,}Z$/.test(d) ? d : undefined;
};

export function parseApplePage(body: string): { jobs: JobItem[]; total: number } {
  const data = (JSON.parse(body) as { res?: { searchResults?: Rec[]; totalRecords?: number } }).res ?? {};
  const jobs: JobItem[] = [];
  for (const j of data.searchResults ?? []) {
    const id = s_(j.id) ?? s_(j.positionId);
    const title = s_(j.postingTitle);
    if (!id || !title) continue;
    const places = (Array.isArray(j.locations) ? (j.locations as Rec[]) : []).map(place).filter((x): x is string => !!x);
    const remote = j.homeOffice === true ? ['Remote'] : [];
    const slug = s_(j.transformedPostingTitle);
    jobs.push({
      key: `job:apple:${id.toLowerCase()}`,
      title,
      location: [places[0], ...remote].filter(Boolean).join(', ') || undefined,
      other_locations: places.length > 1 ? places.slice(1, 21) : undefined,
      department: s_((j.team as Rec | undefined)?.teamName),
      company: 'Apple',
      url: `https://jobs.apple.com/en-us/details/${encodeURIComponent(id)}${slug ? `/${encodeURIComponent(slug)}` : ''}`,
      posted_at: postedAt(j.postDateInGMT),
      source: 'apple',
      ...jobDetails([title, j.jobSummary]),
    });
  }
  return { jobs, total: typeof data.totalRecords === 'number' ? data.totalRecords : jobs.length };
}

/** Read up to MAX_JOBS newest postings. `post` performs one search request for a 1-based page and returns the body. */
export async function collectApple(firstPage: string, post: (page: number) => Promise<string>): Promise<Extraction> {
  const first = parseApplePage(firstPage);
  const seen = new Map(first.jobs.map((j) => [j.key, j]));
  const pages = Math.ceil(Math.min(first.total, MAX_JOBS) / PAGE_SIZE);
  for (let page = 2; page <= pages; page++) {
    const next = parseApplePage(await post(page));
    if (next.jobs.length === 0) break;
    for (const j of next.jobs) if (!seen.has(j.key)) seen.set(j.key, j);
  }
  return { jobs: [...seen.values()], complete: first.total <= MAX_JOBS };
}
