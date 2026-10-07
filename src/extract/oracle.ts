/**
 * Oracle Recruiting Cloud career sites
 * ({host}.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}).
 *
 * The site's own job search is a public REST finder
 * (/hcmRestApi/resources/latest/recruitingCEJobRequisitions) that returns
 * requisitions newest first with the total, PAGE_SIZE per request. Large
 * employers list thousands of jobs, so a check reads the newest MAX_JOBS and
 * marks the extraction incomplete when there were more, as for Workday.
 */
import { jobDetails } from './details.js';
import type { Extraction, JobItem } from './types.js';

export const PAGE_SIZE = 100;
export const MAX_JOBS = 300;

const HOST = /^[\w-]+(\.[\w-]+)*\.oraclecloud\.com$/;
const SITE = /^[\w-]+$/;
const API_PATH = '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';

/** Whose site each host is: the hosts are opaque tenant codes, and the API does not name the company. */
export const COMPANIES: Readonly<Record<string, string>> = {
  'ebfr.fa.us2.oraclecloud.com': 'Oceaneering',
  'ebwh.fa.us2.oraclecloud.com': 'Macy\'s',
  'ebxr.fa.us2.oraclecloud.com': 'DTCC',
  'ecsr.fa.us2.oraclecloud.com': 'Vanderbilt University',
  'ecwl.fa.us2.oraclecloud.com': 'ClubCorp',
  'ecwr.fa.us2.oraclecloud.com': 'Estes Express Lines',
  'eczd.fa.us2.oraclecloud.com': 'Yum! Brands',
  'edbz.fa.us2.oraclecloud.com': 'Texas Instruments',
  'edel.fa.us2.oraclecloud.com': 'Fortinet',
  'edmn.fa.us2.oraclecloud.com': 'Caesars Entertainment',
  'eeho.fa.us2.oraclecloud.com': 'Oracle',
  'efds.fa.em5.oraclecloud.com': 'Ford',
  'efet.fa.us2.oraclecloud.com': 'Hilton',
  'efuq.fa.us6.oraclecloud.com': 'Hilton Grand Vacations',
  'egay.fa.us6.oraclecloud.com': 'NOV',
  'egud.fa.us2.oraclecloud.com': 'AutoZone',
  'egug.fa.us2.oraclecloud.com': 'American Express',
  'eimy.fa.us6.oraclecloud.com': 'UW Health',
  'ejhp.fa.us6.oraclecloud.com': 'Sherwin-Williams',
  'ejis.fa.us6.oraclecloud.com': 'Mount Sinai',
  'ejjc.fa.us6.oraclecloud.com': 'TTX',
  'ejko.fa.us2.oraclecloud.com': 'Blue Cross Blue Shield of Michigan',
  'ejta.fa.us6.oraclecloud.com': 'Fortive',
  'ejwl.fa.us2.oraclecloud.com': 'Marriott',
  'ekaw.fa.us2.oraclecloud.com': 'Securitas',
  'elar.fa.us2.oraclecloud.com': 'Inova',
  'eluq.fa.us2.oraclecloud.com': 'Kroger',
  'emcm.fa.us2.oraclecloud.com': 'WM',
  'emje.fa.us6.oraclecloud.com': 'Southern Company',
  'eodr.fa.us2.oraclecloud.com': 'Tenet Healthcare',
  'eofd.fa.us6.oraclecloud.com': 'Albertsons',
  'eofe.fa.us2.oraclecloud.com': 'BNY',
  'eppr.fa.us2.oraclecloud.com': 'Northwell Health',
  'erqh.fa.us2.oraclecloud.com': 'Atlantic Health System',
  'evac.fa.us2.oraclecloud.com': 'Providence',
  'fa-esgu-saasfaprod1.fa.ocs.oraclecloud.com': 'Mortenson',
  'fa-espx-saasfaprod1.fa.ocs.oraclecloud.com': 'Cummins',
  'fa-etbx-saasfaprod1.fa.ocs.oraclecloud.com': 'Navy Federal Credit Union',
  'fa-etjd-saasfaprod1.fa.ocs.oraclecloud.com': 'FirstEnergy',
  'fa-etnf-saasfaprod1.fa.ocs.oraclecloud.com': 'UChicago Medicine',
  'fa-etnv-saasfaprod1.fa.ocs.oraclecloud.com': 'HealthPartners',
  'fa-etqo-saasfaprod1.fa.ocs.oraclecloud.com': 'Hexaware',
  'fa-etum-saasfaprod1.fa.ocs.oraclecloud.com': 'Florida Blue',
  'fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com': 'Zensar',
  'fa-euwp-saasfaprod1.fa.ocs.oraclecloud.com': 'Mayo Clinic',
  'fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com': 'Nokia',
  'fa-ewgu-saasfaprod1.fa.ocs.oraclecloud.com': 'Chubb',
  'fa-ewlq-saasfaprod1.fa.ocs.oraclecloud.com': 'University of Tennessee',
  'fa-ewxu-saasfaprod1.fa.ocs.oraclecloud.com': 'APS',
  'fa-exdv-saasfaprod1.fa.ocs.oraclecloud.com': 'Westfield Insurance',
  'fa-exew-saasfaprod1.fa.ocs.oraclecloud.com': 'RB Global',
  'fa-exhh-saasfaprod1.fa.ocs.oraclecloud.com': 'Staples',
  'fa-extu-saasfaprod1.fa.ocs.oraclecloud.com': 'Akamai',
  'fa-exty-saasfaprod1.fa.ocs.oraclecloud.com': 'Howmet Aerospace',
  'fa-exvu-saasfaprod1.fa.ocs.oraclecloud.com': 'GM Financial',
  'hccz.fa.em3.oraclecloud.com': 'Pearson',
  'hcgn.fa.us2.oraclecloud.com': 'Citizens',
  'hckd.fa.us2.oraclecloud.com': 'Molina Healthcare',
  'hcwp.fa.us2.oraclecloud.com': 'Coherent',
  'hdep.fa.us2.oraclecloud.com': 'Digital Realty',
  'hdjq.fa.us2.oraclecloud.com': 'Emerson',
  'hdkk.fa.us6.oraclecloud.com': 'Cedars-Sinai',
  'hdox.fa.us6.oraclecloud.com': 'Quest Diagnostics',
  'hdpc.fa.us2.oraclecloud.com': 'Goldman Sachs',
  'hdsn.fa.us6.oraclecloud.com': 'American Tower',
  'iazbqy.fa.ocs.oraclecloud.com': 'International Paper',
  'iazuqy.fa.ocs.oraclecloud.com': 'UCSF',
  'ibmwjb.fa.ocs.oraclecloud.com': 'Brookdale Senior Living',
  'ibpcjb.fa.ocs.oraclecloud.com': 'Ascension',
  'ibpwjb.fa.ocs.oraclecloud.com': 'First Horizon',
  'ibqbjb.fa.ocs.oraclecloud.com': 'Honeywell',
  'ibtcjb.fa.ocs.oraclecloud.com': 'Cherokee Federal',
  'ibxwjb.fa.ocs.oraclecloud.com': 'Dollar General',
  'icfcjb.fa.ocs.oraclecloud.com': 'Honeywell Aerospace',
  'jpmc.fa.oraclecloud.com': 'JPMorganChase',
};

export function resolveOracle(u: URL): { apiUrl: string } | null {
  const host = u.hostname.toLowerCase();
  if (!HOST.test(host)) return null;
  // /hcmUI/CandidateExperience/en/sites/CX_1001/job/123 or /hcmUI/CandidateExperience/en/sites/CX_1001
  const segs = u.pathname.split('/').filter(Boolean);
  const at = segs.indexOf('sites');
  let site = segs[0] === 'hcmUI' && segs[1] === 'CandidateExperience' && at > 0 ? segs[at + 1] : undefined;
  if (!site && u.pathname === API_PATH) site = /siteNumber=([^,;&]+)/.exec(decodeURIComponent(u.search))?.[1];
  return site && SITE.test(site) ? { apiUrl: pageUrl(`https://${host}`, site, 0) } : null;
}

export function pageUrl(origin: string, site: string, offset: number): string {
  return `${origin}${API_PATH}?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${site},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`;
}

/** The site of an API URL: its origin and site number. */
function siteOf(apiUrl: string): { origin: string; site: string } {
  const u = new URL(apiUrl);
  return { origin: u.origin, site: /siteNumber=([^,;&]+)/.exec(decodeURIComponent(u.search))?.[1] ?? '' };
}

/** The public job search of the site an API URL reads. */
export function siteUrlFor(apiUrl: string): string {
  const { origin, site } = siteOf(apiUrl);
  return `${origin}/hcmUI/CandidateExperience/en/sites/${site}`;
}

type Rec = Record<string, unknown>;
const s_ = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function parseOraclePage(body: string, apiUrl: string): { jobs: JobItem[]; total: number } {
  const data = JSON.parse(body) as { items?: { requisitionList?: Rec[]; TotalJobsCount?: number }[] };
  const search = data.items?.[0];
  if (!search) throw new Error('unexpected Oracle Recruiting response');
  const site = siteUrlFor(apiUrl);
  const company = COMPANIES[new URL(apiUrl).hostname];
  const jobs: JobItem[] = [];
  for (const r of search.requisitionList ?? []) {
    const id = s_(String(r.Id ?? ''));
    const title = s_(r.Title);
    if (!id || !title) continue;
    const primary = s_(r.PrimaryLocation);
    const remote = /remote/i.test(String(r.WorkplaceType ?? '')) && !/remote/i.test(primary ?? '') ? 'Remote' : undefined;
    const location = [primary, remote].filter(Boolean).join(', ') || undefined;
    const others = Array.isArray(r.secondaryLocations) ? [...new Set((r.secondaryLocations as Rec[]).map((l) => s_(l?.Name)).filter((x): x is string => !!x && x !== primary))] : [];
    jobs.push({
      key: `job:oracle:${id}`,
      title,
      location,
      other_locations: others.length ? others.slice(0, 20) : undefined,
      department: s_(r.JobFamily) ?? s_(r.JobFunction),
      company,
      url: `${site}/job/${id}`,
      posted_at: s_(r.PostedDate),
      source: 'oracle',
      ...jobDetails([title, r.ShortDescriptionStr, r.ExternalQualificationsStr, r.ExternalResponsibilitiesStr]),
    });
  }
  return { jobs, total: typeof search.TotalJobsCount === 'number' ? search.TotalJobsCount : jobs.length };
}

/** Read up to MAX_JOBS newest requisitions. `get` fetches one page URL and returns the body. */
export async function collectOracle(apiUrl: string, firstPage: string, get: (url: string) => Promise<string>): Promise<Extraction> {
  const first = parseOraclePage(firstPage, apiUrl);
  const { origin, site } = siteOf(apiUrl);
  const seen = new Map(first.jobs.map((j) => [j.key, j]));
  const limit = Math.min(first.total, MAX_JOBS);
  for (let offset = PAGE_SIZE; offset < limit; offset += PAGE_SIZE) {
    const next = parseOraclePage(await get(pageUrl(origin, site, offset)), apiUrl);
    if (next.jobs.length === 0) break;
    for (const j of next.jobs) if (!seen.has(j.key)) seen.set(j.key, j);
  }
  return { jobs: [...seen.values()], complete: first.total <= MAX_JOBS };
}
