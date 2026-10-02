/**
 * Pay and experience, read from a posting. Platforms that publish a structured
 * pay range are read directly; everything else comes from the posting text
 * ("$150,000 - $200,000/yr", "5+ years of experience"). Both are heuristics
 * over what the employer wrote, so a posting that states neither simply has
 * no `salary` / `experience_years`.
 */
import type { Salary, SalaryPeriod } from './types.js';

const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', amp: '&', euro: '€', pound: '£' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
  });
}

/** Posting HTML (possibly entity-escaped, as Greenhouse sends it) to one line of plain text. */
export function htmlToText(html: string): string {
  let s = html;
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

const PER_YEAR: Record<SalaryPeriod, number> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };
/** Plausible bounds per period; anything outside is some other number (a bonus, a market size). */
const BOUNDS: Record<SalaryPeriod, [number, number]> = { year: [10_000, 5_000_000], month: [500, 400_000], week: [200, 100_000], day: [40, 20_000], hour: [5, 1_000] };

export function makeSalary(min: number | undefined, max: number | undefined, period: SalaryPeriod, currency?: string): Salary | undefined {
  const ok = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= BOUNDS[period][0] && n <= BOUNDS[period][1];
  let lo = ok(min) ? min : undefined;
  let hi = ok(max) ? max : undefined;
  if (lo === undefined && hi === undefined) return undefined;
  if (lo !== undefined && hi !== undefined && lo > hi) [lo, hi] = [hi, lo];
  const annual = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * PER_YEAR[period]));
  return { min: lo, max: hi, currency: currency?.toUpperCase(), period, annual_min: annual(lo), annual_max: annual(hi) };
}

/** "1 YEAR", "per-year-salary", "HOUR", "monthly" → a period. */
export function periodOf(v: unknown): SalaryPeriod | undefined {
  const s = String(v ?? '').toLowerCase();
  if (/year|annual|annum|\byr\b/.test(s)) return 'year';
  if (/month/.test(s)) return 'month';
  if (/week/.test(s)) return 'week';
  if (/hour|\bhr\b/.test(s)) return 'hour';
  if (/da(y|ily)/.test(s)) return 'day';
  return undefined;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
// Not followed by a magnitude: "$20M", "$1.5 billion", "$15T" are not pay.
const NOT_BIG = String.raw`(?![\d,.]*\s?(?:[mMbBtT]\b|MM\b|million|billion|trillion|bn\b))`;
const SYMBOL = String.raw`((?:US|CA|C|AU|A|NZ|S|HK)?\$|£|€)`;
const RANGE = new RegExp(`${SYMBOL}\\s?${NUM}\\s?([kK])?${NOT_BIG}\\s*(?:-|–|—|to|and)\\s*(?:(?:US|CA|C|AU|A|NZ|S|HK)?\\$|£|€)?\\s?${NUM}\\s?([kK])?${NOT_BIG}`, 'g');
const CODE_RANGE = new RegExp(`\\b(USD|CAD|AUD|NZD|SGD|EUR|GBP)\\s?${NUM}\\s?([kK])?${NOT_BIG}\\s*(?:-|–|—|to)\\s*${NUM}\\s?([kK])?${NOT_BIG}`, 'g');
const SINGLE = new RegExp(`${SYMBOL}\\s?${NUM}\\s?([kK])?${NOT_BIG}`, 'g');

const SYMBOL_CURRENCY: Record<string, string> = { $: 'USD', US$: 'USD', CA$: 'CAD', C$: 'CAD', AU$: 'AUD', A$: 'AUD', NZ$: 'NZD', S$: 'SGD', HK$: 'HKD', '£': 'GBP', '€': 'EUR' };
const PERIOD_AFTER = /^\s*(?:[A-Z]{3}\b\s*)?(?:(?:\/|per\s|an?\s)\s*(year|yr|annum|hour|hr|month|mo|week|wk|day)\b|(annually|annual|yearly|hourly|monthly|weekly))/i;
const CODE_AFTER = /^\s*(?:\/\s?\w+\s*)?\(?(USD|CAD|AUD|NZD|SGD|HKD|EUR|GBP)\b/;

const toNumber = (digits: string, k: string | undefined) => Number(digits.replace(/,/g, '')) * (k ? 1000 : 1);

function periodNear(text: string, start: number, end: number, top: number): SalaryPeriod | undefined {
  const after = PERIOD_AFTER.exec(text.slice(end, end + 30));
  const stated = periodOf(after?.[1] === 'mo' ? 'month' : after?.[1] === 'wk' ? 'week' : (after?.[1] ?? after?.[2]));
  if (stated) return stated;
  if (top >= BOUNDS.year[0]) return 'year';
  // Small figures are only pay when the sentence says they are hourly.
  if (top <= BOUNDS.hour[1] && /\b(hourly|per hour|an hour|\/\s?h(ou)?r)\b/i.test(text.slice(Math.max(0, start - 60), end + 30))) return 'hour';
  return undefined;
}

/** The pay range a posting states in its text, if any. Several ranges (pay zones) are merged into the widest. */
export function parseSalaryText(text: string): Salary | undefined {
  const found: Salary[] = [];
  const add = (m: RegExpExecArray, currency: string | undefined, lo: number, hi: number | undefined) => {
    const end = m.index + m[0].length;
    const period = periodNear(text, m.index, end, hi ?? lo);
    if (!period) return;
    const code = CODE_AFTER.exec(text.slice(end, end + 16))?.[1];
    const s = makeSalary(lo, hi, period, code ?? currency);
    if (s) found.push(s);
  };
  for (const m of text.matchAll(RANGE)) {
    let lo = toNumber(m[2]!, m[3]);
    const hi = toNumber(m[4]!, m[5]);
    if (!m[3] && m[5] && lo < 1000) lo *= 1000; // "$150-200K"
    add(m, SYMBOL_CURRENCY[m[1]!.toUpperCase()], lo, hi);
  }
  if (!found.length) {
    for (const m of text.matchAll(CODE_RANGE)) {
      let lo = toNumber(m[2]!, m[3]);
      if (!m[3] && m[5] && lo < 1000) lo *= 1000;
      add(m, m[1], lo, toNumber(m[4]!, m[5]));
    }
  }
  if (!found.length) {
    // A lone figure counts only when the words before it say it is pay.
    for (const m of text.matchAll(SINGLE)) {
      const before = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
      if (!/\b(salary|compensation|pay|base|wage|rate|ote|earn|earnings)\b/.test(before) || /\b(bonus|stipend|budget|allowance|reimburse\w*|credit)\b[^.]{0,30}$/.test(before)) continue;
      const value = toNumber(m[2]!, m[3]);
      const upTo = /\bup to\s*$/.test(before);
      const period = periodNear(text, m.index, m.index + m[0].length, value);
      const s = period && makeSalary(upTo ? undefined : value, upTo ? value : undefined, period, SYMBOL_CURRENCY[m[1]!.toUpperCase()]);
      if (s) {
        found.push(s);
        break;
      }
    }
  }
  const first = found[0];
  if (!first) return undefined;
  const same = found.filter((s) => s.period === first.period && s.currency === first.currency);
  const mins = same.map((s) => s.min).filter((n): n is number => n !== undefined);
  const maxes = same.map((s) => s.max ?? s.min).filter((n): n is number => n !== undefined);
  const lone = same.length === 1;
  return makeSalary(mins.length ? Math.min(...mins) : undefined, lone ? first.max : Math.max(...maxes), first.period, first.currency);
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
// The tail is a lookahead so a second mention inside it is still matched on its own.
const YEARS = new RegExp(String.raw`\b${COUNT}\s*(\+|plus\b)?\s*(?:(?:-|–|—|to)\s*${COUNT}\s*\+?\s*)?(?:years?|yrs?)\b['’]?\s*(?=(.{0,70}))`, 'gi');
const EXPERIENCE_AHEAD = /\b(experience|exp\b)/i;
const EXPERIENCE_BEHIND = /\bexperience\s*(?:required|level|needed)?\s*[:\-–(]?\s*(?:of\s+)?(?:at least\s+|minimum\s+(?:of\s+)?)?$/i;
const EXPERIENCE_LEAD = /^(?:of\b|in\b|as\b|working\b|building\b|developing\b|designing\b|shipping\b|leading\b|managing\b|professional\b|relevant\b|hands[\s-]on\b|industry\b)/i;
// "for over 20 years we have…", "in the last 3 years", "5 years ago", "401k after 2 years"
const NOT_A_REQUIREMENT_BEFORE = /\b(for|over the|in the|the|past|last|next|every|within|after|than)\s+(?:over|more than|nearly|almost|about|the\s+)?\s*$/i;
const NOT_A_REQUIREMENT_AFTER = /^(?:ago|old|in business|of age|later|of (?:university|college|school|study|education))\b/i;

/**
 * Minimum years of experience a posting asks for: the first requirement-like
 * mention ("5+ years of experience", "3-5 years in a sales role" → 3).
 */
export function parseExperienceYears(text: string): number | undefined {
  for (const m of text.matchAll(YEARS)) {
    const years = WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
    // Only the rest of the sentence says what the years are of.
    const tail = (m[4] ?? '').split(/[.;!?]\s/)[0]!;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (years > 25 || NOT_A_REQUIREMENT_AFTER.test(tail)) continue;
    if (EXPERIENCE_BEHIND.test(before)) return years;
    const explicit = m[2] !== undefined || m[3] !== undefined; // "5+" or "3-5" reads as a requirement on its own
    if (!explicit && NOT_A_REQUIREMENT_BEFORE.test(before)) continue;
    if (EXPERIENCE_LEAD.test(tail) || EXPERIENCE_AHEAD.test(tail)) return years;
  }
  return undefined;
}

export interface JobDetails {
  salary?: Salary;
  experience_years?: number;
}

/**
 * Details for one posting. `structured` is the platform's own pay field when it
 * has one; `parts` are the title and description fields (HTML or plain text).
 */
export function jobDetails(parts: unknown[], structured?: Salary): JobDetails {
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => (p.includes('<') || p.includes('&') ? htmlToText(p) : p))
    .join(' . ')
    .slice(0, 60_000);
  const out: JobDetails = {};
  const salary = structured ?? (text ? parseSalaryText(text) : undefined);
  if (salary) out.salary = salary;
  const years = text ? parseExperienceYears(text) : undefined;
  if (years !== undefined) out.experience_years = years;
  return out;
}
