/**
 * Finding a company's job board when all you have is the company.
 *
 * Two ways, both ending in a request to the platform's own public listing API
 * that confirms the board exists and has open jobs:
 *   1. the company's careers page links to (or embeds) its board;
 *   2. the board is named after the company ("acme" → jobs.ashbyhq.com/acme).
 *
 * Used by watch creation (a careers page with no job markup that links to a
 * supported board is watched through that board) and by
 * scripts/discover-boards.ts, which grows the directory from a company list.
 */
import { resolveSource } from '../extract/adapters.js';
import { PLATFORM_ADAPTERS, type AdapterName } from '../extract/types.js';

/** Path segments that follow a platform host but are not a company's board. */
const NOT_A_BOARD = new Set(['embed', 'api', 'j', 'jobs', 'job', 'careers', 'www', 'static', 'assets', 'cdn', 'app', 'apply', 'v0', 'v1', 'postings', 'posting-api', 'include', 'widget', 'spi']);

/** Pattern, how to build the board URL from a match, and which group names the company (checked against NOT_A_BOARD). */
const BOARD_LINKS: [RegExp, (m: RegExpExecArray) => string, number][] = [
  [/(?:job-)?boards(\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s<>]*&(?:amp;)?)?for=([\w-]+)/gi, (m) => `https://boards${m[1] ?? ''}.greenhouse.io/${m[2]}`, 2],
  [/(?:job-)?boards(\.eu)?\.greenhouse\.io\/([\w-]+)/gi, (m) => `https://boards${m[1] ?? ''}.greenhouse.io/${m[2]}`, 2],
  [/jobs(\.eu)?\.lever\.co\/([\w-]+)/gi, (m) => `https://jobs${m[1] ?? ''}.lever.co/${m[2]}`, 2],
  [/jobs\.ashbyhq\.com\/([\w.%-]+)/gi, (m) => `https://jobs.ashbyhq.com/${m[1]}`, 1],
  [/apply\.workable\.com\/([\w-]+)/gi, (m) => `https://apply.workable.com/${m[1]}`, 1],
  [/(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/gi, (m) => `https://jobs.smartrecruiters.com/${m[1]}`, 1],
  [/\b([\w-]+)\.recruitee\.com/gi, (m) => `https://${m[1]!.toLowerCase()}.recruitee.com`, 1],
  [/\b([\w-]+\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/g, (m) => `https://${m[1]!.toLowerCase()}/${m[2]}`, 1],
];

/** Board URLs a page links to or embeds, most-mentioned first. Only URLs Watchtower reads through a platform adapter. */
export function detectBoardLinks(html: string): string[] {
  const seen = new Map<string, number>();
  const text = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  for (const [re, toUrl, company] of BOARD_LINKS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const slug = (m[company] ?? '').toLowerCase();
      if (!slug || NOT_A_BOARD.has(slug)) continue;
      let url: string;
      try {
        url = toUrl(m);
        if (!PLATFORM_ADAPTERS.has(resolveSource(url).adapter)) continue;
      } catch {
        continue;
      }
      seen.set(url, (seen.get(url) ?? 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url);
}

/** Where a company's careers page usually lives, most likely first. */
export function careersPageCandidates(website: string): string[] {
  let origin: string;
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    origin = `https://${u.hostname}`;
  } catch {
    return [];
  }
  return [`${origin}/careers`, `${origin}/jobs`, origin];
}

const slugify = (s: string, joiner: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|corp|co|labs?|technologies|technology|hq)\b\.?$/g, (w) => (/^labs?$/.test(w) ? w : ''))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/ +/g, joiner);

/**
 * Board names a company is likely to have used: the label of its domain
 * ("acme" for acme.com, "getacme" for getacme.io) and its name, run together
 * and hyphenated. Short or generic guesses are left out; they match someone else.
 */
export function slugCandidates(name: string, website?: string): string[] {
  const out: string[] = [];
  if (website) {
    try {
      const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
      const labels = host.split('.');
      // acme.com → acme; acme.co.uk → acme; app.acme.com → acme
      const label = labels.length >= 3 && labels[labels.length - 2]!.length <= 3 ? labels[labels.length - 3] : labels[labels.length - 2];
      if (label) out.push(label);
    } catch {
      /* no usable website */
    }
  }
  out.push(slugify(name, ''), slugify(name, '-'));
  return [...new Set(out)].filter((s) => s.length >= 4 && /^[a-z0-9-]+$/.test(s)).slice(0, 3);
}

export type ProbePlatform = Extract<AdapterName, 'ashby' | 'greenhouse' | 'lever' | 'workable'>;

/** The platforms whose boards can be confirmed from a name alone, with the public URL of a board and how to count its jobs. */
export const PROBES: Record<ProbePlatform, { boardUrl: (slug: string) => string; listingUrl: (slug: string) => string; jobs: (body: unknown) => number; company?: (body: unknown) => string | undefined }> = {
  ashby: {
    boardUrl: (s) => `https://jobs.ashbyhq.com/${s}`,
    listingUrl: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    jobs: (b) => ((b as { jobs?: { isListed?: boolean }[] })?.jobs ?? []).filter((j) => j?.isListed !== false).length,
  },
  greenhouse: {
    boardUrl: (s) => `https://boards.greenhouse.io/${s}`,
    listingUrl: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    jobs: (b) => (b as { jobs?: unknown[] })?.jobs?.length ?? 0,
    company: (b) => (b as { jobs?: { company_name?: string }[] })?.jobs?.[0]?.company_name,
  },
  lever: {
    boardUrl: (s) => `https://jobs.lever.co/${s}`,
    listingUrl: (s) => `https://api.lever.co/v0/postings/${s}?mode=json&limit=5`,
    jobs: (b) => (Array.isArray(b) ? b.length : 0),
  },
  workable: {
    boardUrl: (s) => `https://apply.workable.com/${s}`,
    listingUrl: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`,
    jobs: (b) => (b as { jobs?: unknown[] })?.jobs?.length ?? 0,
    company: (b) => (b as { name?: string })?.name,
  },
};

/** The probe platform and slug of a board URL, if it is on one of them. */
export function probeTarget(boardUrl: string): { platform: ProbePlatform; slug: string } | null {
  try {
    const { adapter, fetchUrl } = resolveSource(boardUrl);
    if (!(adapter in PROBES)) return null;
    const slug = /\/(?:boards|postings|job-board|accounts)\/([^/?]+)/.exec(fetchUrl)?.[1];
    return slug ? { platform: adapter as ProbePlatform, slug } : null;
  } catch {
    return null;
  }
}
