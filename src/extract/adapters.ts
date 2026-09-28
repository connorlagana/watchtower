/**
 * Source adapters. A job watch on a Greenhouse or Lever board is fetched
 * through that platform's public, documented job-board JSON API instead of
 * scraping the HTML; everything else goes through the generic HTML path.
 */
import { extractHtml, normalizeLines, stableJsonLines } from './html.js';
import { extractJsonLd, parseJsonLdBlocks } from './jsonld.js';
import type { AdapterName, Extraction, JobItem } from './types.js';

export type WatchKind = 'url' | 'jobs' | 'events';

export interface ResolvedSource {
  adapter: AdapterName;
  /** The URL Watchtower actually fetches. */
  fetchUrl: string;
}

/** Canonicalize a URL for resource sharing: lowercase host, drop fragment and default port. */
export function canonicalUrl(input: string): string {
  const u = new URL(input);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  return u.toString();
}

export function resolveSource(input: string, kind: WatchKind): ResolvedSource {
  const u = new URL(input);
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  if (kind === 'jobs') {
    // boards.greenhouse.io/{token}, job-boards.greenhouse.io/{token}, boards.greenhouse.io/embed/job_board?for={token}
    if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
      const token = segs[0] === 'embed' ? u.searchParams.get('for') : segs[0];
      if (token && /^[\w-]+$/.test(token)) {
        const api = host.includes('.eu.') ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
        return { adapter: 'greenhouse', fetchUrl: `https://${api}/v1/boards/${token}/jobs` };
      }
    }
    if (/^boards-api(\.eu)?\.greenhouse\.io$/.test(host) && segs[0] === 'v1' && segs[1] === 'boards' && segs[2]) {
      return { adapter: 'greenhouse', fetchUrl: `https://${host}/v1/boards/${segs[2]}/jobs` };
    }
    // jobs.lever.co/{company}
    if (/^jobs(\.eu)?\.lever\.co$/.test(host) && segs[0] && /^[\w-]+$/.test(segs[0])) {
      const api = host.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
      return { adapter: 'lever', fetchUrl: `https://${api}/v0/postings/${segs[0]}?mode=json` };
    }
    if (/^api(\.eu)?\.lever\.co$/.test(host) && segs[0] === 'v0' && segs[1] === 'postings' && segs[2]) {
      return { adapter: 'lever', fetchUrl: `https://${host}/v0/postings/${segs[2]}?mode=json` };
    }
  }
  return { adapter: 'html', fetchUrl: canonicalUrl(input) };
}

function jobsText(jobs: JobItem[]): string {
  return jobs
    .map((j) => [j.title, j.location, j.department].filter(Boolean).join(' — '))
    .sort()
    .join('\n');
}

function greenhouse(body: string): Extraction {
  const data = JSON.parse(body) as { jobs?: Record<string, unknown>[] };
  const jobs: JobItem[] = (data.jobs ?? []).map((j) => {
    const depts = (j.departments as { name?: string }[] | undefined)?.map((d) => d.name).filter(Boolean);
    return {
      key: `job:greenhouse:${j.id}`,
      title: String(j.title ?? '').trim(),
      location: (j.location as { name?: string } | undefined)?.name?.trim() || undefined,
      department: depts?.length ? depts.join(', ') : undefined,
      url: typeof j.absolute_url === 'string' ? j.absolute_url : undefined,
      posted_at: typeof j.first_published === 'string' ? j.first_published : undefined,
      source: 'greenhouse',
    };
  });
  return { title: null, text: jobsText(jobs), jobs, events: [] };
}

function lever(body: string): Extraction {
  const data = JSON.parse(body) as Record<string, unknown>[];
  if (!Array.isArray(data)) throw new Error('unexpected Lever response');
  const jobs: JobItem[] = data.map((j) => {
    const cat = (j.categories ?? {}) as Record<string, unknown>;
    return {
      key: `job:lever:${j.id}`,
      title: String(j.text ?? '').trim(),
      location: typeof cat.location === 'string' ? cat.location : undefined,
      department: [cat.team, cat.commitment].filter((x) => typeof x === 'string').join(', ') || undefined,
      url: typeof j.hostedUrl === 'string' ? j.hostedUrl : undefined,
      posted_at: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : undefined,
      source: 'lever',
    };
  });
  return { title: null, text: jobsText(jobs), jobs, events: [] };
}

export function extract(
  adapter: AdapterName,
  body: string,
  contentType: string,
  opts: { baseUrl?: string; selector?: string } = {},
): Extraction {
  if (adapter === 'greenhouse') return greenhouse(body);
  if (adapter === 'lever') return lever(body);

  const ct = contentType.toLowerCase();
  const looksHtml = ct.includes('html') || (!ct && /^\s*<(!doctype|html|head|body)/i.test(body));
  if (looksHtml) return extractHtml(body, opts);

  if (ct.includes('json')) {
    try {
      const parsed = JSON.parse(body);
      const ld = ct.includes('ld+json') ? extractJsonLd(parseJsonLdBlocks([body]), opts.baseUrl) : { jobs: [], events: [] };
      return { title: null, text: normalizeLines(stableJsonLines(parsed).join('\n')), ...ld };
    } catch {
      /* fall through to plain text */
    }
  }
  return { title: null, text: normalizeLines(body), jobs: [], events: [] };
}
