/**
 * Microsoft's own careers site (apply.careers.microsoft.com, an Eightfold
 * site; jobs.careers.microsoft.com and careers.microsoft.com lead there).
 * It is read like any Eightfold site (see eightfold.ts), and answers quick
 * successive requests with HTTP 429.
 */
import { collectEightfold, type EightfoldSite, MAX_JOBS, PAGE_SIZE, PAGE_SPACING_MS, pageUrl as eightfoldPageUrl, parseEightfoldPage } from './eightfold.js';
import type { Extraction, JobItem } from './types.js';

export { MAX_JOBS, PAGE_SIZE, PAGE_SPACING_MS };
export const SITE_URL = 'https://apply.careers.microsoft.com/careers';
const SITE: EightfoldSite = { origin: 'https://apply.careers.microsoft.com', domain: 'microsoft.com', source: 'microsoft', company: 'Microsoft' };

export function resolveMicrosoft(u: URL): { apiUrl: string } | null {
  return /^(apply\.|jobs\.)?careers\.microsoft\.com$/.test(u.hostname.toLowerCase()) ? { apiUrl: pageUrl(0) } : null;
}

export function pageUrl(start: number): string {
  return eightfoldPageUrl(SITE, start);
}

export function parseMicrosoftPage(body: string): { jobs: JobItem[]; total: number } {
  return parseEightfoldPage(body, SITE);
}

/** Read up to MAX_JOBS newest postings. `get` fetches one page URL and returns the body. */
export function collectMicrosoft(firstPage: string, get: (url: string) => Promise<string>): Promise<Extraction> {
  return collectEightfold(SITE, firstPage, get);
}
