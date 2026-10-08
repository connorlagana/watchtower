/**
 * SAP SuccessFactors career sites (Career Site Builder), served from the
 * company's own host, such as careers.paramount.com. Nothing in such a URL
 * says SuccessFactors, so only the hosts in SITES are read this way; any
 * other careers page still goes through its JobPosting markup.
 *
 * There is no public JSON API (the one the site's own scripts call is under
 * /services/, which robots.txt disallows). The site's search page, sorted by
 * posting date, lists a page of jobs (25 on most sites, 10 to 100 on others)
 * with title, location and date, and states the total ("Showing 1 to 25 of
 * 282 Jobs", or "Results 1 – 25 of 282" on older themes). A check reads the
 * newest MAX_JOBS and marks the extraction incomplete when there were more,
 * as for Workday.
 *
 * Some themes render results with JavaScript, so their search page lists
 * nothing. Those sites are read from sitemap.xml, which lists every open job:
 * as an RSS feed with each job's title, location, function and text on some
 * sites, and as bare URLs on others, whose jobs are partial (title from the
 * URL slug, which also carries the location; no location or date).
 */
import * as cheerio from 'cheerio';
import { jobDetails } from './details.js';
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
  'careers.hcltech.com': 'HCLTech',
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
  'careers.quiktrip.com': 'QuikTrip',
  'careers.rossstores.com': 'Ross Stores',
  'careers.sap.com': 'SAP',
  'careers.skyworksinc.com': 'Skyworks',
  'careers.te.com': 'TE Connectivity',
  'careers.thehersheycompany.com': 'Hershey',
  'careers.timken.com': 'Timken',
  'careers.triumphgroup.com': 'Triumph Group',
  'careers.underarmour.com': 'Under Armour',
  'careers.wipro.com': 'Wipro',
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
  'join.cnh.com': 'CNH',
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

export function sitemapUrl(origin: string): string {
  return `${origin}/sitemap.xml`;
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

const xmlText = (s: string | undefined) =>
  text(
    s
      ?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&'),
  );
const tag = (item: string, name: string) => xmlText(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item)?.[1]);

function titleFromSlug(slug: string): string {
  let t = slug;
  try {
    t = decodeURIComponent(slug);
  } catch {
    /* keep the raw slug */
  }
  return t.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every job in the site's sitemap: an RSS feed of whole postings, or a urlset of job URLs (partial jobs). */
export function parseSuccessFactorsSitemap(xml: string, searchUrl: string): JobItem[] {
  const company = companyFor(searchUrl);
  const jobs = new Map<string, JobItem>();
  const pathOf = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  };
  if (/<rss[\s>]/.test(xml.slice(0, 500))) {
    for (const [item] of xml.matchAll(/<item>[\s\S]*?<\/item>/g)) {
      const url = tag(item, 'link');
      const id = tag(item, 'g:id') ?? JOB_PATH.exec(pathOf(url ?? ''))?.[1];
      const location = tag(item, 'g:location');
      // "Staff Electrical Engineer (Nashua, NH, US)": the location is repeated after the title.
      let title = tag(item, 'title');
      if (title && location && title.endsWith(`(${location})`)) title = title.slice(0, -location.length - 2).trim();
      if (!id || !title || !url) continue;
      jobs.set(`job:successfactors:${id}`, {
        key: `job:successfactors:${id}`,
        title,
        location,
        department: tag(item, 'g:job_function'),
        company,
        url,
        source: 'successfactors',
        ...jobDetails([title, tag(item, 'description')]),
      });
    }
  } else {
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const url = m[1]!.replace(/&amp;/g, '&');
      const path = /^(?:\/[\w-]+)?\/job\/([^/]+)\/(\d+)\/?$/.exec(pathOf(url));
      if (!path) continue;
      const key = `job:successfactors:${path[2]}`;
      if (!jobs.has(key)) jobs.set(key, { key, title: titleFromSlug(path[1]!), company, url, source: 'successfactors', partial: true });
    }
  }
  return [...jobs.values()];
}

/**
 * Read up to MAX_JOBS newest postings from the search pages, or every job
 * from the sitemap when the search page lists none. `get` fetches one URL of
 * the site and returns the body.
 */
export async function collectSuccessFactors(searchUrl: string, firstPage: string, get: (url: string) => Promise<string>): Promise<Extraction> {
  const first = parseSuccessFactorsPage(firstPage, searchUrl);
  const origin = new URL(searchUrl).origin;
  if (first.jobs.length === 0) {
    const jobs = parseSuccessFactorsSitemap(await get(sitemapUrl(origin)), searchUrl);
    // An empty search page and an empty sitemap is more likely a broken site than a company with no openings.
    if (jobs.length === 0) throw new Error('SuccessFactors site listed no jobs on its search page or sitemap');
    return { jobs, complete: true };
  }
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
