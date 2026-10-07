/**
 * SAP SuccessFactors career sites (Career Site Builder), served from the
 * company's own host, such as careers.paramount.com. Nothing in such a URL
 * says SuccessFactors, so only the hosts in SITES are read this way; any
 * other careers page still goes through its JobPosting markup.
 *
 * There is no public JSON API. The site's search page, sorted by posting
 * date, lists a page of jobs (25 on most sites, 10 to 100 on others) with
 * title, location and date, and
 * states the total ("Showing 1 to 25 of 282 Jobs", or "Results 1 – 25 of 282"
 * on older themes). A check reads the newest MAX_JOBS and marks the
 * extraction incomplete when there were more, as for Workday.
 */
import * as cheerio from 'cheerio';
import type { Extraction, JobItem } from './types.js';

export const MAX_JOBS = 200;
/** Search pages read per check at most, whatever the site's page size. */
export const MAX_PAGES = 8;

/** Career Site Builder hosts, and whose site each is. */
export const SITES: Readonly<Record<string, string>> = {
  'careers.acuityinc.com': 'Acuity',
  'careers.aflac.com': 'Aflac',
  'careers.agcocorp.com': 'AGCO',
  'careers.amtrak.com': 'Amtrak',
  'careers.belden.com': 'Belden',
  'careers.bv.com': 'Black & Veatch',
  'careers.bwxt.com': 'BWXT',
  'careers.capgemini.com': 'Capgemini',
  'careers.celestica.com': 'Celestica',
  'careers.centerpointenergy.com': 'CenterPoint Energy',
  'careers.cintas.com': 'Cintas',
  'careers.consumersenergy.com': 'Consumers Energy',
  'careers.criver.com': 'Charles River Laboratories',
  'careers.dominionenergy.com': 'Dominion Energy',
  'careers.dteenergy.com': 'DTE Energy',
  'careers.ey.com': 'EY',
  'careers.hfsinclair.com': 'HF Sinclair',
  'careers.hubbell.com': 'Hubbell',
  'careers.huntingtoningalls.com': 'Huntington Ingalls Industries',
  'careers.jetblue.com': 'JetBlue',
  'careers.mohawkind.com': 'Mohawk Industries',
  'careers.owenscorning.com': 'Owens Corning',
  'careers.paramount.com': 'Paramount',
  'careers.pge.com': 'PG&E',
  'careers.phillips66.com': 'Phillips 66',
  'careers.qorvo.com': 'Qorvo',
  'careers.sap.com': 'SAP',
  'careers.thehersheycompany.com': 'Hershey',
  'careers.timken.com': 'Timken',
  'careers.triumphgroup.com': 'Triumph Group',
  'careers.underarmour.com': 'Under Armour',
  'careers.wyndhamhotels.com': 'Wyndham Hotels & Resorts',
  'jobs.ametek.com': 'AMETEK',
  'jobs.ball.com': 'Ball',
  'jobs.bokf.com': 'BOK Financial',
  'jobs.bostonscientific.com': 'Boston Scientific',
  'jobs.bunge.com': 'Bunge',
  'jobs.cargill.com': 'Cargill',
  'jobs.cmc.com': 'CMC',
  'jobs.commscope.com': 'CommScope',
  'jobs.deere.com': 'John Deere',
  'jobs.eastman.com': 'Eastman',
  'jobs.enersys.com': 'EnerSys',
  'jobs.entergy.com': 'Entergy',
  'jobs.erieinsurance.com': 'Erie Insurance',
  'jobs.exxonmobil.com': 'ExxonMobil',
  'jobs.grainger.com': 'Grainger',
  'jobs.gxo.com': 'GXO',
  'jobs.halliburton.com': 'Halliburton',
  'jobs.harley-davidson.com': 'Harley-Davidson',
  'jobs.inglescareers.com': 'Ingles Markets',
  'jobs.l3harris.com': 'L3Harris',
  'jobs.lear.com': 'Lear',
  'jobs.lincolnelectric.com': 'Lincoln Electric',
  'jobs.lincolnfinancial.com': 'Lincoln Financial',
  'jobs.mcdonalds.com': 'McDonald\'s',
  'jobs.netapp.com': 'NetApp',
  'jobs.newyorklife.com': 'New York Life',
  'jobs.nexteraenergy.com': 'NextEra Energy',
  'jobs.nscorp.com': 'Norfolk Southern',
  'jobs.nucor.com': 'Nucor',
  'jobs.paccar.com': 'PACCAR',
  'jobs.teradyne.com': 'Teradyne',
  'jobs.vailresortscareers.com': 'Vail Resorts',
  'jobs.xpo.com': 'XPO',
  'kiewitcareers.kiewit.com': 'Kiewit',
};

/** /job/{slug}/{id}/, sometimes under a brand prefix (/ey/job/…, /DalTile/job/…). */
const JOB_PATH = /^(?:\/[\w-]+)?\/job\/[^/]+\/(\d+)\/?$/;

export function resolveSuccessFactors(u: URL): { searchUrl: string } | null {
  const host = u.hostname.toLowerCase();
  return SITES[host] ? { searchUrl: pageUrl(`https://${host}`, 0) } : null;
}

export function pageUrl(origin: string, startrow: number): string {
  return `${origin}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
}

export function companyFor(searchUrl: string): string | undefined {
  return SITES[new URL(searchUrl).hostname];
}

const text = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() || undefined;

/** "Oct 7, 2026" → "2026-10-07". Dates in other locales' formats are not kept. */
function postedDate(v: string | undefined): string | undefined {
  if (!v || !/[a-z]{3}/i.test(v) || !/\d{4}/.test(v)) return undefined;
  const t = Date.parse(`${v} UTC`);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

export function parseSuccessFactorsPage(html: string, searchUrl: string): { jobs: JobItem[]; total: number } {
  const $ = cheerio.load(html);
  const origin = new URL(searchUrl).origin;
  const company = companyFor(searchUrl);
  const jobs = new Map<string, JobItem>();
  $('a.jobTitle-link[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').replace(/[?#].*$/, '');
    const id = JOB_PATH.exec(href)?.[1];
    const title = text($(a).text());
    if (!id || !title || jobs.has(`job:successfactors:${id}`)) return;
    // Tile themes give each field an id (job-{id}-desktop-section-location-value); table themes a span class in the row.
    const field = (name: string, cls: string) => text($(`#job-${id}-desktop-section-${name}-value`).first().text()) ?? text($(a).closest('tr').find(cls).first().text());
    jobs.set(`job:successfactors:${id}`, {
      key: `job:successfactors:${id}`,
      title,
      location: field('location', '.jobLocation'),
      company,
      url: `${origin}${href}`,
      posted_at: postedDate(field('date', '.jobDate')),
      source: 'successfactors',
    });
  });
  const label = $('#tile-search-results-label').text() || $('.paginationLabel').first().text();
  const total = /of\s*([\d,.]+)/i.exec(label)?.[1]?.replace(/[,.]/g, '');
  return { jobs: [...jobs.values()], total: total ? Number(total) : jobs.size };
}

/** Read up to MAX_JOBS newest postings. `get` fetches one search page URL and returns the body. */
export async function collectSuccessFactors(searchUrl: string, firstPage: string, get: (url: string) => Promise<string>): Promise<Extraction> {
  const first = parseSuccessFactorsPage(firstPage, searchUrl);
  if (first.jobs.length === 0 && first.total > 0) throw new Error('SuccessFactors search page listed no jobs');
  const origin = new URL(searchUrl).origin;
  const seen = new Map(first.jobs.map((j) => [j.key, j]));
  const limit = Math.min(first.total, MAX_JOBS);
  // Sites differ in page size, so pages are stepped by the size of the first.
  const step = first.jobs.length;
  for (let start = step, pages = 1; step > 0 && start < limit && pages < MAX_PAGES; start += step, pages++) {
    const next = parseSuccessFactorsPage(await get(pageUrl(origin, start)), searchUrl);
    if (next.jobs.length === 0) break;
    for (const j of next.jobs) if (!seen.has(j.key)) seen.set(j.key, j);
  }
  return { jobs: [...seen.values()], complete: seen.size >= first.total };
}
