/**
 * Google's own careers site (careers.google.com, which redirects to
 * www.google.com/about/careers/applications).
 *
 * Google's robots.txt disallows the job search and job pages, so the only
 * readable source is the jobs sitemap, which lists every open job (id and a
 * slug of the title) in one request. The slug drops everything after the
 * first comma of the real title ("Senior Software Engineer, Infrastructure"
 * becomes senior-software-engineer), and there is no location. Every job is
 * therefore partial, like an iCIMS sitemap-only entry.
 */
import type { Extraction, JobItem } from './types.js';

export const SITEMAP_URL = 'https://www.google.com/about/careers/applications/jobs/sitemap.xml';
export const SITE_URL = 'https://www.google.com/about/careers/applications/jobs/results';

export function resolveGoogle(u: URL): { sitemapUrl: string } | null {
  const host = u.hostname.toLowerCase();
  if (host === 'careers.google.com') return { sitemapUrl: SITEMAP_URL };
  if (host === 'www.google.com' && /^\/about\/careers\/applications(\/|$)/.test(u.pathname)) return { sitemapUrl: SITEMAP_URL };
  return null;
}

const JOB_PATH = /\/jobs\/results\/(\d+)-([^/?#]*)/;
const ROMAN = /^(i|ii|iii|iv|v|vi)$/;

/** "software-engineer-iii" → "Software Engineer III". */
function titleFromSlug(slug: string): string {
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    /* keep the raw slug */
  }
  return text
    .split('-')
    .filter(Boolean)
    .map((w) => (ROMAN.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function parseGoogleSitemap(xml: string): Extraction {
  const jobs = new Map<string, JobItem>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const path = JOB_PATH.exec(m[1]!);
    if (!path) continue;
    const key = `job:google:${path[1]}`;
    const title = titleFromSlug(path[2]!);
    if (!title || jobs.has(key)) continue;
    jobs.set(key, { key, title, company: 'Google', url: `${SITE_URL}/${path[1]}-${path[2]}`, source: 'google', partial: true });
  }
  return { jobs: [...jobs.values()], complete: true };
}
