/**
 * HTML normalization: reduce a page to stable, line-oriented visible text so
 * that markup churn (scripts, attributes, whitespace, CSRF tokens, relative
 * timestamps) does not register as a change.
 */
import * as cheerio from 'cheerio';
import { extractTextDates } from './dates.js';
import { extractJsonLd, parseJsonLdBlocks } from './jsonld.js';
import type { Extraction } from './types.js';

export const MAX_TEXT_CHARS = 200_000;

const STRIP = 'script, style, noscript, template, svg, canvas, iframe, object, embed, link, meta, head, input[type="hidden"], [hidden], [aria-hidden="true"]';
const BLOCK =
  'address, article, aside, blockquote, br, dd, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, tr, td, th, ul, option, summary, details';

/** Volatile tokens that change on every load but carry no meaning. */
const NOISE: [RegExp, string][] = [
  [/\b\d+\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+ago\b/gi, '<recently>'],
  [/\b(just now|moments ago)\b/gi, '<recently>'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '<token>'], // session ids, csrf tokens, cache busters
];

export function normalizeLines(text: string): string {
  const lines: string[] = [];
  for (let line of text.split('\n')) {
    line = line.replace(/[\s ​]+/g, ' ').trim();
    for (const [re, rep] of NOISE) line = line.replace(re, rep);
    if (line) lines.push(line);
  }
  const joined = lines.join('\n');
  return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
}

export function extractHtml(html: string, opts: { baseUrl?: string; selector?: string } = {}): Extraction {
  const $ = cheerio.load(html);
  const jsonLdBlocks = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text())
    .get();
  const title = $('title').first().text().replace(/\s+/g, ' ').trim() || $('h1').first().text().replace(/\s+/g, ' ').trim() || null;

  $(STRIP).remove();
  // Drop HTML comments.
  $('*')
    .contents()
    .filter((_, n) => n.type === 'comment')
    .remove();
  // Source-code line breaks inside a text run are layout noise, not structure.
  $('*')
    .contents()
    .each((_, n) => {
      if (n.type === 'text') n.data = n.data.replace(/\s+/g, ' ');
    });
  $(BLOCK).each((_, el) => {
    $(el).prepend('\n').append('\n');
  });

  let regions: string[];
  if (opts.selector) {
    let sel;
    try {
      sel = $(opts.selector);
    } catch {
      throw new Error(`invalid CSS selector "${opts.selector}"`);
    }
    // A missing region yields empty text, so its (re)appearance is itself a change.
    regions = sel.map((_, el) => $(el).text()).get();
  } else {
    regions = [$('body').length ? $('body').text() : $.root().text()];
  }
  const text = normalizeLines(regions.join('\n'));

  const { jobs, events: ldEvents } = extractJsonLd(parseJsonLdBlocks(jsonLdBlocks), opts.baseUrl);
  const events = ldEvents.length ? ldEvents : extractTextDates(text);
  return { title, text, jobs, events };
}

/** Deterministic JSON rendering (sorted keys, one leaf per line) so API/JSON diffs are line-stable. */
export function stableJsonLines(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${prefix}${prefix ? ': ' : ''}${JSON.stringify(value)}`];
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.keys(value as object)
        .sort()
        .map((k) => [k, (value as Record<string, unknown>)[k]] as const);
  if (entries.length === 0) return [`${prefix}${prefix ? ': ' : ''}${Array.isArray(value) ? '[]' : '{}'}`];
  return entries.flatMap(([k, v]) => stableJsonLines(v, prefix ? `${prefix}.${k}` : k));
}
