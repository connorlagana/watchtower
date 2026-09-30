/**
 * Careers pages that aren't on a supported job-board platform are read
 * through their schema.org JobPosting JSON-LD, never the visible text.
 */
import * as cheerio from 'cheerio';
import { extractJsonLd, parseJsonLdBlocks } from './jsonld.js';
import type { Extraction } from './types.js';

export function extractHtml(html: string, opts: { baseUrl?: string } = {}): Extraction {
  const $ = cheerio.load(html);
  const jsonLdBlocks = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text())
    .get();
  return extractJsonLd(parseJsonLdBlocks(jsonLdBlocks), opts.baseUrl);
}
