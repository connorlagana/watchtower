/**
 * Microsoft's own careers site (apply.careers.microsoft.com, an Eightfold
 * site; jobs.careers.microsoft.com and careers.microsoft.com lead there).
 *
 * The site's search endpoint (/api/pcsx/search, which robots.txt allows)
 * returns postings newest first, PAGE_SIZE per request, with the total. It
 * answers requests in quick succession with HTTP 429, even a few seconds
 * apart, so a check reads at most the newest MAX_JOBS, PAGE_SPACING_MS apart,
 * and keeps what it has when a later page is refused. Such a listing is
 * incomplete, so a page it could not read never looks like removals.
 */
import type { Extraction, JobItem } from './types.js';

export const PAGE_SIZE = 10;
export const MAX_JOBS = 50;
export const PAGE_SPACING_MS = 3000;
export const SITE_URL = 'https://apply.careers.microsoft.com/careers';
const ORIGIN = 'https://apply.careers.microsoft.com';

export function resolveMicrosoft(u: URL): { apiUrl: string } | null {
  return /^(apply\.|jobs\.)?careers\.microsoft\.com$/.test(u.hostname.toLowerCase()) ? { apiUrl: pageUrl(0) } : null;
}

export function pageUrl(start: number): string {
  return `${ORIGIN}/api/pcsx/search?domain=microsoft.com&query=&location=&start=${start}&sort_by=timestamp`;
}

type Rec = Record<string, unknown>;
const s_ = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.map(s_).filter((x): x is string => !!x) : []);

export function parseMicrosoftPage(body: string): { jobs: JobItem[]; total: number } {
  const data = (JSON.parse(body) as { data?: { positions?: Rec[]; count?: number } }).data ?? {};
  const jobs: JobItem[] = [];
  for (const p of data.positions ?? []) {
    const id = s_(String(p.displayJobId ?? p.atsJobId ?? ''));
    const title = s_(p.name);
    const path = s_(p.positionUrl);
    if (!id || !title || !path) continue;
    // "United States, Washington, Redmond" names the state in full; the standardized "Redmond, WA, US" does not.
    const places = strings(p.locations).length ? strings(p.locations) : strings(p.standardizedLocations);
    const remote = p.workLocationOption === 'remote' ? ['Remote'] : [];
    const posted = typeof p.postedTs === 'number' ? new Date(p.postedTs * 1000).toISOString() : undefined;
    jobs.push({
      key: `job:microsoft:${id}`,
      title,
      location: [places[0], ...remote].filter(Boolean).join(', ') || undefined,
      other_locations: places.length > 1 ? places.slice(1, 21) : undefined,
      department: s_(p.department),
      company: 'Microsoft',
      url: `${ORIGIN}${path}`,
      posted_at: posted,
      source: 'microsoft',
    });
  }
  return { jobs, total: typeof data.count === 'number' ? data.count : jobs.length };
}

/** Read up to MAX_JOBS newest postings. `get` fetches one page URL and returns the body. */
export async function collectMicrosoft(firstPage: string, get: (url: string) => Promise<string>): Promise<Extraction> {
  const first = parseMicrosoftPage(firstPage);
  const seen = new Map(first.jobs.map((j) => [j.key, j]));
  const limit = Math.min(first.total, MAX_JOBS);
  let refused = false;
  for (let start = PAGE_SIZE; start < limit; start += PAGE_SIZE) {
    const body = await get(pageUrl(start)).catch(() => null);
    if (body === null) {
      refused = true;
      break;
    }
    const next = parseMicrosoftPage(body);
    if (next.jobs.length === 0) break;
    for (const j of next.jobs) if (!seen.has(j.key)) seen.set(j.key, j);
  }
  return { jobs: [...seen.values()], complete: first.total <= MAX_JOBS && !refused };
}
