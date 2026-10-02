/**
 * Grow the board directory from a list of companies.
 *
 *   npm run discover -- companies.json boards.txt
 *
 * companies.json is an array of { "name": "...", "website": "https://..." }.
 * For each company the script (1) reads its careers page for a link to a
 * supported board, and failing that (2) tries boards named after the company.
 * Every candidate is confirmed against the platform's public listing API and
 * kept only if it has open jobs. boards.txt gets one board URL per line, in the
 * format INDEX_BOARDS_FILE reads; a .json twin records how each was found.
 *
 * Careers pages are fetched through the same fetcher the server uses: SSRF
 * checks, robots.txt, size and time limits, an identifying User-Agent.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { robotsAllows } from '../src/fetch/robots.js';
import { safeFetch } from '../src/fetch/safeFetch.js';
import { careersPageCandidates, detectBoardLinks, PROBES, probeTarget, slugCandidates, type ProbePlatform } from '../src/search/discover.js';
import { fetchOptions } from '../src/services/context.js';

interface Company {
  name: string;
  website?: string;
}
interface Found {
  company: string;
  board: string;
  platform: ProbePlatform;
  jobs: number;
  via: 'careers-page' | 'name';
}

const [input, output = 'boards.txt'] = process.argv.slice(2);
if (!input) {
  console.error('usage: npm run discover -- companies.json [boards.txt]');
  process.exit(1);
}
const config = loadConfig();
const opts = { ...fetchOptions(config), timeoutMs: 10_000 };
const companies = (JSON.parse(await readFile(input, 'utf8')) as Company[]).filter((c) => c && typeof c.name === 'string' && c.name.trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One queue per platform: a few requests at a time, slowing down when asked to. */
class Lane {
  private active = 0;
  private waiting: (() => void)[] = [];
  private pauseUntil = 0;
  constructor(
    private readonly width: number,
    private readonly gapMs: number,
  ) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.width) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      const wait = this.pauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      await sleep(this.gapMs);
      this.active--;
      this.waiting.shift()?.();
    }
  }
  pause(ms: number) {
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms);
  }
}
const lanes: Record<ProbePlatform, Lane> = { ashby: new Lane(3, 150), greenhouse: new Lane(3, 150), lever: new Lane(3, 150), workable: new Lane(1, 3000) };
/** Workable rate-limits its listing API hard, so its boards are only confirmed when a careers page links to one, never guessed by name. */
const GUESSABLE: ProbePlatform[] = ['ashby', 'greenhouse', 'lever'];
const probed = new Map<string, Promise<number>>();

/** Open jobs on a board, or 0 when it does not exist. Each board is asked about once. */
function confirm(platform: ProbePlatform, slug: string): Promise<number> {
  const key = `${platform}/${slug.toLowerCase()}`;
  let p = probed.get(key);
  if (!p) {
    p = lanes[platform].run(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await safeFetch(PROBES[platform].listingUrl(slug), { ...opts, maxBytes: config.maxApiBodyBytes });
          if (res.status === 429 || res.status >= 500) {
            if (platform === 'workable') return 0;
            lanes[platform].pause(5000 * (attempt + 1));
            await sleep(5000 * (attempt + 1));
            continue;
          }
          return res.status === 200 ? PROBES[platform].jobs(JSON.parse(res.body)) : 0;
        } catch {
          return 0;
        }
      }
      return 0;
    });
    probed.set(key, p);
  }
  return p;
}

async function fromCareersPage(c: Company): Promise<Found | null> {
  for (const url of c.website ? careersPageCandidates(c.website) : []) {
    let html: string;
    try {
      if (!(await robotsAllows(url, opts))) continue;
      const res = await safeFetch(url, opts);
      if (res.status !== 200) continue;
      html = res.body;
    } catch {
      continue;
    }
    for (const board of detectBoardLinks(html).slice(0, 3)) {
      const target = probeTarget(board);
      if (!target) continue;
      const jobs = await confirm(target.platform, target.slug);
      if (jobs > 0) return { company: c.name, board: PROBES[target.platform].boardUrl(target.slug), platform: target.platform, jobs, via: 'careers-page' };
    }
  }
  return null;
}

async function fromName(c: Company): Promise<Found | null> {
  for (const slug of slugCandidates(c.name, c.website)) {
    const hits = await Promise.all(GUESSABLE.map(async (platform) => ({ platform, jobs: await confirm(platform, slug) })));
    const best = hits.sort((a, b) => b.jobs - a.jobs)[0]!;
    if (best.jobs > 0) return { company: c.name, board: PROBES[best.platform].boardUrl(slug), platform: best.platform, jobs: best.jobs, via: 'name' };
  }
  return null;
}

const found: Found[] = [];
let done = 0;
const queue = [...companies];
const save = async () => {
  const unique = [...new Map(found.map((f) => [f.board.toLowerCase(), f])).values()].sort((a, b) => a.board.localeCompare(b.board));
  await writeFile(output, `${unique.map((f) => f.board).join('\n')}\n`);
  await writeFile(output.replace(/(\.\w+)?$/, '.json'), JSON.stringify(unique, null, 1));
  return unique.length;
};
await Promise.all(
  Array.from({ length: 24 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const hit = (await fromCareersPage(c).catch(() => null)) ?? (await fromName(c).catch(() => null));
      if (hit) found.push(hit);
      if (++done % 100 === 0) console.log(`${done}/${companies.length} companies, ${await save()} boards`);
    }
  }),
);
const total = await save();
const by = (k: keyof Found) => Object.fromEntries([...new Set(found.map((f) => f[k]))].map((v) => [v, found.filter((f) => f[k] === v).length]));
console.log(`done: ${total} boards from ${companies.length} companies`, by('platform'), by('via'));
process.exit(0);
