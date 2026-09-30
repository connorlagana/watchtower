/**
 * iCIMS career portals ({anything}.icims.com, usually careers-{company}).
 *
 * There is no public JSON API. The portal's sitemap.xml lists every open job
 * (id and a slug of the title) in one request, and the first page of
 * /jobs/search lists the newest postings with their real title, location
 * and posting date. A check reads both: the sitemap decides which jobs exist,
 * the search page fills in details for the newest ones. Jobs seen only in
 * the sitemap are marked partial; the checker keeps details it learned
 * earlier for them.
 */
import * as cheerio from 'cheerio';
import type { Extraction, JobItem } from './types.js';

const RESERVED = new Set(['www', 'community', 'careers', 'cdn13', 'media', 'help', 'support', 'developer', 'developers']);

export function resolveIcims(u: URL): { sitemapUrl: string } | null {
  const host = u.hostname.toLowerCase();
  const m = /^([\w-]+)\.icims\.com$/.exec(host);
  if (!m || RESERVED.has(m[1]!)) return null;
  return { sitemapUrl: `https://${host}/sitemap.xml` };
}

export function searchUrlFor(sitemapUrl: string): string {
  return `${new URL(sitemapUrl).origin}/jobs/search?ss=1&in_iframe=1`;
}

const JOB_PATH = /\/jobs\/(\d+)\/([^/]*)\/job\b/;

function titleFromSlug(slug: string): string {
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    /* keep the raw slug */
  }
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/---/g, ' \u2013 ')
    .replace(/-/g, ' ')
    .replace(/\u2013/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function parseIcimsSitemap(xml: string): JobItem[] {
  const jobs = new Map<string, JobItem>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const loc = m[1]!.replace(/&amp;/g, '&');
    const path = JOB_PATH.exec(loc);
    if (!path) continue;
    const key = `job:icims:${path[1]}`;
    if (!jobs.has(key)) jobs.set(key, { key, title: titleFromSlug(path[2]!), url: loc, source: 'icims', partial: true });
  }
  return [...jobs.values()];
}

/** "9/29/2026 3:15 PM" (portal-local time) → "2026-09-29". */
function postedDate(title: string | undefined): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(title ?? '');
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : undefined;
}

export function parseIcimsSearch(html: string): JobItem[] {
  const $ = cheerio.load(html);
  const jobs: JobItem[] = [];
  $('a.iCIMS_Anchor[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const path = JOB_PATH.exec(href);
    if (!path) return;
    const card = $(a).closest('li, .iCIMS_JobCardItem, tr');
    const title = ($(a).find('h3').first().text() || $(a).text()).replace(/\s+/g, ' ').trim();
    if (!title) return;
    const location = card.find('.header.left span').not('.sr-only').first().text().replace(/\s+/g, ' ').trim() || undefined;
    const posted = postedDate(card.find('.header.right span[title]').first().attr('title'));
    let url = href.replace(/[?#].*$/, '');
    try {
      url = new URL(url).toString();
    } catch {
      /* relative or odd href: keep as is */
    }
    jobs.push({ key: `job:icims:${path[1]}`, title, location, url, posted_at: posted, source: 'icims' });
  });
  return jobs;
}

/** Sitemap decides membership; search-page rows override the sitemap's slug-derived entries. */
export function collectIcims(sitemapXml: string, searchHtml: string | null): Extraction {
  const byKey = new Map(parseIcimsSitemap(sitemapXml).map((j) => [j.key, j]));
  if (searchHtml) for (const j of parseIcimsSearch(searchHtml)) byKey.set(j.key, j);
  return { jobs: [...byKey.values()], complete: true };
}
