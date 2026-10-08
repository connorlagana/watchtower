/**
 * Eightfold career sites ({tenant}.eightfold.ai/careers?domain={domain}, and
 * company hosts served by Eightfold such as apply.careers.microsoft.com).
 *
 * The site's search endpoint (/api/pcsx/search, which Eightfold's robots.txt
 * allows) returns postings newest first, PAGE_SIZE per request, with the
 * total. Some sites answer requests in quick succession with HTTP 429, even a
 * few seconds apart, so a check reads at most the newest MAX_JOBS,
 * PAGE_SPACING_MS apart, and keeps what it has when a later page is refused.
 * Such a listing is incomplete, so a page it could not read never looks like
 * removals.
 *
 * Some sites have not turned that endpoint on (it answers 403) and serve the
 * older /api/apply/v2/jobs instead, which robots.txt also allows: the same
 * postings with their full text, in the site's own order (roughly newest
 * first; it ignores sorting). Nothing on the careers page says which one a
 * site answers, so the tenants in LEGACY are read through the older one.
 */
import { jobDetails } from './details.js';
import type { Extraction, JobItem } from './types.js';

export const PAGE_SIZE = 10;
export const MAX_JOBS = 50;
export const PAGE_SPACING_MS = 3000;

const TENANT = /^([\w-]+)\.eightfold\.ai$/;

/** Whose site each tenant is, where the tenant name does not read as the company's ("jhu", "lockheedmartin"). */
export const COMPANIES: Readonly<Record<string, string>> = {
  'caci': 'CACI',
  'dsm': 'dsm-firmenich',
  'eaton': 'Eaton',
  'ericsson': 'Ericsson',
  'infineon': 'Infineon',
  'jhu': 'Johns Hopkins University',
  'lamresearch': 'Lam Research',
  'lockheedmartin': 'Lockheed Martin',
  'lumen': 'Lumen',
  'qualcomm': 'Qualcomm',
  'ralliant': 'Ralliant',
  'slb': 'SLB',
  'starbucks': 'Starbucks',
  'trinet': 'TriNet',
  'ukg': 'UKG',
  'vialto': 'Vialto Partners',
  'vodafone': 'Vodafone',
  'whirlpool': 'Whirlpool',
  'albemarle': 'Albemarle',
  'bayer': 'Bayer',
  'bcg': 'BCG',
  'fcx': 'Freeport-McMoRan',
  'fluor': 'Fluor',
  'hsbc': 'HSBC',
  'insight': 'Insight',
  'libertymutual': 'Liberty Mutual',
  'stmicroelectronics': 'STMicroelectronics',
  'symetra': 'Symetra',
  'vale': 'Vale',
};

/** Tenants that serve only the older /api/apply/v2/jobs endpoint. */
export const LEGACY: ReadonlySet<string> = new Set(['albemarle', 'bayer', 'bcg', 'fcx', 'fluor', 'hsbc', 'insight', 'libertymutual', 'stmicroelectronics', 'symetra', 'vale']);
const LEGACY_PATH = '/api/apply/v2/jobs';
const DOMAIN = /^[\w-]+(\.[\w-]+)+$/;

export interface EightfoldSite {
  /** The origin serving the site. */
  origin: string;
  /** The domain the site's jobs are listed under. */
  domain: string;
  source: 'eightfold' | 'microsoft';
  /** The company, when the site is a single known company's. */
  company?: string;
  /** Read through the older /api/apply/v2/jobs endpoint. */
  legacy?: boolean;
}

/** {tenant}.eightfold.ai, with the domain from ?domain= or else {tenant}.com. */
export function resolveEightfold(u: URL): { apiUrl: string } | null {
  const tenant = TENANT.exec(u.hostname.toLowerCase())?.[1];
  if (!tenant || ['www', 'app', 'apply'].includes(tenant)) return null;
  const domain = (u.searchParams.get('domain') ?? `${tenant}.com`).toLowerCase();
  if (!DOMAIN.test(domain)) return null;
  const legacy = LEGACY.has(tenant) || u.pathname === LEGACY_PATH;
  return { apiUrl: pageUrl({ origin: `https://${tenant}.eightfold.ai`, domain, legacy }, 0) };
}

export function pageUrl(site: Pick<EightfoldSite, 'origin' | 'domain' | 'legacy'>, start: number): string {
  if (site.legacy) return `${site.origin}${LEGACY_PATH}?domain=${site.domain}&start=${start}&num=${PAGE_SIZE}`;
  return `${site.origin}/api/pcsx/search?domain=${site.domain}&query=&location=&start=${start}&sort_by=timestamp`;
}

/** The site an API URL reads (for a {tenant}.eightfold.ai URL). */
export function siteOf(apiUrl: string): EightfoldSite {
  const u = new URL(apiUrl);
  const tenant = TENANT.exec(u.hostname)?.[1] ?? '';
  return { origin: u.origin, domain: u.searchParams.get('domain') ?? '', source: 'eightfold', company: COMPANIES[tenant], legacy: u.pathname === LEGACY_PATH };
}

/** The public careers page of a {tenant}.eightfold.ai site. */
export function siteUrlFor(apiUrl: string): string {
  const { origin, domain } = siteOf(apiUrl);
  return `${origin}/careers?domain=${domain}`;
}

type Rec = Record<string, unknown>;
const s_ = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.map(s_).filter((x): x is string => !!x) : []);

/** Both endpoints: pcsx nests { positions, count } under data and uses camelCase; v2 has them at the top level, snake_case. */
export function parseEightfoldPage(body: string, site: EightfoldSite): { jobs: JobItem[]; total: number } {
  const raw = JSON.parse(body) as { data?: { positions?: Rec[]; count?: number }; positions?: Rec[]; count?: number };
  const data = raw.data ?? raw;
  const jobs: JobItem[] = [];
  for (const p of data.positions ?? []) {
    const id = s_(String(p.displayJobId ?? p.display_job_id ?? p.atsJobId ?? p.ats_job_id ?? ''));
    const title = s_(p.name);
    const path = s_(p.positionUrl);
    const url = path ? `${site.origin}${path}` : (s_(p.canonicalPositionUrl) ?? (p.id !== undefined ? `${site.origin}/careers/job/${p.id}` : undefined));
    if (!id || !title || !url) continue;
    // "United States, Washington, Redmond" names the state in full; the standardized "Redmond, WA, US" does not.
    const places = strings(p.locations).length ? strings(p.locations) : strings(p.standardizedLocations);
    const remote = (p.workLocationOption ?? p.work_location_option) === 'remote' ? ['Remote'] : [];
    const ts = p.postedTs ?? p.t_create;
    const posted = typeof ts === 'number' ? new Date(ts * 1000).toISOString() : undefined;
    jobs.push({
      key: `job:${site.source}:${id}`,
      title,
      location: [places[0], ...remote].filter(Boolean).join(', ') || undefined,
      other_locations: places.length > 1 ? places.slice(1, 21) : undefined,
      department: s_(p.department),
      company: site.company,
      url,
      posted_at: posted,
      source: site.source,
      ...(p.job_description ? jobDetails([title, p.job_description]) : {}),
    });
  }
  return { jobs, total: typeof data.count === 'number' ? data.count : jobs.length };
}

/** Read up to MAX_JOBS newest postings. `get` fetches one page URL and returns the body. */
export async function collectEightfold(site: EightfoldSite, firstPage: string, get: (url: string) => Promise<string>): Promise<Extraction> {
  const first = parseEightfoldPage(firstPage, site);
  const seen = new Map(first.jobs.map((j) => [j.key, j]));
  const limit = Math.min(first.total, MAX_JOBS);
  let refused = false;
  for (let start = PAGE_SIZE; start < limit; start += PAGE_SIZE) {
    const body = await get(pageUrl(site, start)).catch(() => null);
    if (body === null) {
      refused = true;
      break;
    }
    const next = parseEightfoldPage(body, site);
    if (next.jobs.length === 0) break;
    for (const j of next.jobs) if (!seen.has(j.key)) seen.set(j.key, j);
  }
  return { jobs: [...seen.values()], complete: first.total <= MAX_JOBS && !refused };
}
