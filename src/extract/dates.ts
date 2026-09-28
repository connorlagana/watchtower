/**
 * Fallback for event pages without schema.org markup: find calendar dates in
 * normalized page text so "tell me when this event adds a date" still works.
 */
import type { EventItem } from './types.js';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const PATTERNS: { re: RegExp; parse: (m: RegExpExecArray) => [number, number, number] | null }[] = [
  // 2026-10-12
  { re: /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, parse: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  // October 12, 2026 / Oct 12 2026 / Oct. 12th, 2026
  {
    re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi'),
    parse: (m) => [Number(m[3]), MONTHS[m[1]!.slice(0, 3).toLowerCase()] ?? 0, Number(m[2])],
  },
  // 12 October 2026
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(20\\d{2})\\b`, 'gi'),
    parse: (m) => [Number(m[3]), MONTHS[m[2]!.slice(0, 3).toLowerCase()] ?? 0, Number(m[1])],
  },
];

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null;
  return date.toISOString().slice(0, 10);
}

export function extractTextDates(text: string, limit = 200): EventItem[] {
  const found = new Map<string, EventItem>();
  for (const line of text.split('\n')) {
    for (const { re, parse } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const parts = parse(m);
        const date = parts && iso(...parts);
        if (!date || found.has(date)) continue;
        const context = line.length > 200 ? `${line.slice(0, 197)}...` : line;
        found.set(date, { key: `date:${date}`, name: context, start_date: date, source: 'text' });
        if (found.size >= limit) return [...found.values()];
      }
    }
  }
  return [...found.values()];
}
