/**
 * Amazon's own careers site (amazon.jobs).
 *
 * The site's search.json returns postings newest first, at most 100 per
 * request, with the full posting text (description and qualifications) but
 * no pay. The hit count is capped at 10,000, well below what Amazon lists, so
 * a check reads the newest MAX_JOBS and the extraction is always incomplete.
 * Hourly warehouse roles live on hiring.amazon.com and are not covered.
 */
import { jobDetails } from './details.js';
import type { Extraction, JobItem } from './types.js';

export const PAGE_SIZE = 100;
export const MAX_JOBS = 300;
export const SITE_URL = 'https://www.amazon.jobs/en/search';

export function resolveAmazon(u: URL): { apiUrl: string } | null {
  return /^(www\.)?amazon\.jobs$/.test(u.hostname.toLowerCase()) ? { apiUrl: pageUrl(0) } : null;
}

export function pageUrl(offset: number): string {
  return `https://www.amazon.jobs/en/search.json?offset=${offset}&result_limit=${PAGE_SIZE}&sort=recent`;
}

type Rec = Record<string, unknown>;
const s_ = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Each entry of `locations` is itself a JSON string. */
function locationsOf(v: unknown): Rec[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((l) => {
    try {
      const x = typeof l === 'string' ? JSON.parse(l) : l;
      return x && typeof x === 'object' ? [x as Rec] : [];
    } catch {
      return [];
    }
  });
}

/** "October  6, 2026" → "2026-10-06". */
function postedDate(v: unknown): string | undefined {
  const d = s_(v);
  const t = d ? Date.parse(`${d.replace(/\s+/g, ' ')} UTC`) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

export function parseAmazonPage(body: string): { jobs: JobItem[]; hits: number } {
  const data = JSON.parse(body) as { error?: unknown; hits?: number; jobs?: Rec[] | null };
  if (data.error) throw new Error(`amazon.jobs: ${String(data.error)}`);
  const jobs: JobItem[] = [];
  for (const j of data.jobs ?? []) {
    const id = s_(j.id_icims) ?? s_(j.id);
    const title = s_(j.title);
    const path = s_(j.job_path);
    if (!id || !title || !path) continue;
    const locs = locationsOf(j.locations);
    const primary = locs.find((l) => l.location === j.location) ?? locs[0];
    const location = s_(j.normalized_location) ?? s_(j.location);
    const others = [...new Set(locs.filter((l) => l !== primary).map((l) => s_(l.normalizedLocation)).filter((x): x is string => !!x && x !== location))];
    jobs.push({
      key: `job:amazon:${id}`,
      title,
      location: primary?.type === 'VIRTUAL' && location ? `${location}, Remote` : location,
      other_locations: others.length ? others.slice(0, 20) : undefined,
      department: s_(j.job_category),
      company: 'Amazon',
      url: `https://www.amazon.jobs${path}`,
      posted_at: postedDate(j.posted_date),
      source: 'amazon',
      ...jobDetails([title, j.description, j.basic_qualifications, j.preferred_qualifications]),
    });
  }
  return { jobs, hits: typeof data.hits === 'number' ? data.hits : jobs.length };
}

/** Read up to MAX_JOBS newest postings. `get` fetches one page URL and returns the body. */
export async function collectAmazon(firstPage: string, get: (url: string) => Promise<string>): Promise<Extraction> {
  const first = parseAmazonPage(firstPage);
  const seen = new Map(first.jobs.map((j) => [j.key, j]));
  const limit = Math.min(first.hits, MAX_JOBS);
  for (let offset = PAGE_SIZE; offset < limit; offset += PAGE_SIZE) {
    const next = parseAmazonPage(await get(pageUrl(offset)));
    if (next.jobs.length === 0) break;
    for (const j of next.jobs) if (!seen.has(j.key)) seen.set(j.key, j);
  }
  return { jobs: [...seen.values()], complete: first.hits <= MAX_JOBS };
}
