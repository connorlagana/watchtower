/** RSS 2.0 / RSS 1.0 (RDF) / Atom parsing. */
import * as cheerio from 'cheerio';
import type { Extraction, FeedItem } from './types.js';

export function looksLikeFeed(body: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('rss') || ct.includes('atom')) return true;
  if (!ct.includes('xml') && ct !== '') return false;
  const head = body.slice(0, 2000).toLowerCase();
  return /<rss[\s>]/.test(head) || /<feed[\s>]/.test(head) || /<rdf:rdf[\s>]/.test(head);
}

const clean = (s: string | undefined) => (s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function extractFeed(body: string, baseUrl?: string): Extraction {
  const $ = cheerio.load(body, { xml: true });
  const abs = (u?: string) => {
    if (!u) return undefined;
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return u;
    }
  };
  const items = new Map<string, FeedItem>();
  const add = (i: Omit<FeedItem, 'key'>, id?: string) => {
    if (!i.title && !i.url) return;
    const key = `item:${(id || i.url || `${i.title}|${i.published_at ?? ''}`).toLowerCase()}`;
    if (!items.has(key)) items.set(key, { key, ...i });
  };

  $('item').each((_, el) => {
    const e = $(el);
    add(
      {
        title: clean(e.children('title').first().text()),
        url: abs(clean(e.children('link').first().text()) || undefined),
        published_at: clean(e.children('pubDate, dc\\:date').first().text()) || undefined,
        summary: clean(e.children('description').first().text()).slice(0, 300) || undefined,
      },
      clean(e.children('guid').first().text()) || undefined,
    );
  });
  $('entry').each((_, el) => {
    const e = $(el);
    const link = e.children('link[rel="alternate"]').first().attr('href') ?? e.children('link').first().attr('href');
    add(
      {
        title: clean(e.children('title').first().text()),
        url: abs(link),
        published_at: clean(e.children('published, updated').first().text()) || undefined,
        summary: clean(e.children('summary, content').first().text()).slice(0, 300) || undefined,
      },
      clean(e.children('id').first().text()) || undefined,
    );
  });

  const list = [...items.values()];
  const title = clean($('channel > title').first().text() || $('feed > title').first().text()) || null;
  return {
    title,
    text: list.map((i) => i.title).join('\n'),
    jobs: [],
    events: [],
    items: list,
    isFeed: true,
  };
}
