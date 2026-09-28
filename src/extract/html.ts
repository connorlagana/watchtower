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

/** Site chrome that is rarely what anyone is watching and churns often. */
const CHROME =
  'nav, aside, footer, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="dialog"], [aria-modal="true"]';
/** Cookie/consent banners, matched loosely by id/class. */
const CONSENT = '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i]';

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
    regions = [mainContentText($)];
  }
  const text = normalizeLines(regions.join('\n'));

  const { jobs, events: ldEvents } = extractJsonLd(parseJsonLdBlocks(jsonLdBlocks), opts.baseUrl);
  const events = ldEvents.length ? ldEvents : extractTextDates(text);
  return { title, text, jobs, events };
}

const textLen = (s: string) => s.replace(/\s+/g, '').length;

/**
 * Pick the part of the page people actually watch: drop navigation, footers,
 * sidebars, dialogs and consent banners, then prefer <main>/<article> when
 * they hold a substantial share of the remaining text.
 */
function mainContentText($: cheerio.CheerioAPI): string {
  const rootText = () => ($('body').length ? $('body').text() : $.root().text());
  const original = rootText();
  const fullLen = textLen(original);
  $(CHROME).remove();
  // Page-level headers only; <header> inside an article is content.
  $('header')
    .filter((_, el) => $(el).closest('main, article, [role="main"]').length === 0)
    .remove();
  $(CONSENT)
    .filter((_, el) => $(el).closest('main, article, [role="main"]').length === 0 && textLen($(el).text()) < 3000)
    .remove();
  const bodyText = rootText();
  const bodyLen = textLen(bodyText);
  // If stripping chrome removed nearly everything, the page is all "chrome"; keep it whole.
  if (fullLen > 0 && bodyLen < fullLen * 0.1) return original;

  const main = $('main, [role="main"]').first();
  if (main.length && textLen(main.text()) >= Math.min(200, bodyLen * 0.25)) return main.text();
  const articles = $('article');
  if (articles.length === 1 && textLen(articles.text()) >= bodyLen * 0.25) return articles.text();
  return bodyText;
}

/**
 * Stable identity for array elements, so inserting one item into a JSON list
 * doesn't renumber (and "change") every line after it.
 */
function arrayKeyField(arr: unknown[]): string | null {
  if (arr.length === 0 || !arr.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) return null;
  for (const field of ['id', 'uuid', 'guid', 'slug', 'key', 'url', 'href']) {
    const vals = arr.map((v) => (v as Record<string, unknown>)[field]);
    if (vals.every((x) => typeof x === 'string' || typeof x === 'number') && new Set(vals).size === vals.length) return field;
  }
  return null;
}

/** Deterministic JSON rendering (sorted keys, one leaf per line) so API/JSON diffs are line-stable. */
export function stableJsonLines(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${prefix}${prefix ? ': ' : ''}${JSON.stringify(value)}`];
  const keyField = Array.isArray(value) ? arrayKeyField(value) : null;
  const entries = Array.isArray(value)
    ? value.map((v, i) => [keyField ? `[${keyField}=${String((v as Record<string, unknown>)[keyField])}]` : String(i), v] as const)
    : Object.keys(value as object)
        .sort()
        .map((k) => [k, (value as Record<string, unknown>)[k]] as const);
  if (entries.length === 0) return [`${prefix}${prefix ? ': ' : ''}${Array.isArray(value) ? '[]' : '{}'}`];
  return entries.flatMap(([k, v]) => stableJsonLines(v, prefix ? `${prefix}.${k}` : k));
}
