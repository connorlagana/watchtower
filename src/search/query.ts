/**
 * Reads a plain-language job request ("iOS jobs in Austin making at least 150k
 * a year with a maximum of 6 years of experience") into watch filters.
 *
 * Rule-based on purpose: Watchtower needs no model or API key, and the caller
 * is itself a language model that sees the interpretation in the response and
 * can correct it by passing explicit filters, which always win.
 */
import type { Seniority } from '../extract/types.js';

export interface ParsedQuery {
  keywords: string[];
  all_keywords: string[];
  exclude_keywords: string[];
  locations: string[];
  seniority: Seniority[];
  remote_only: boolean;
  min_salary?: number;
  salary_currency?: string;
  max_experience_years?: number;
  /** Parts of the request that could not be turned into a filter. */
  notes: string[];
}

const CUT = ' | ';
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const YEARS_OF_EXPERIENCE = String.raw`\+?\s*(?:years?|yrs?)(?:['’]|\s+of)?(?:\s+(?:work\s+|working\s+|professional\s+|relevant\s+|industry\s+)?(?:experience|exp\b))?`;
const LEAD_IN = String.raw`(?:\b(?:and|with|requiring|requires?|that\s+requires?|needing|needs?|for\s+someone\s+with|i\s+have|having)\s+)?(?:\ba\s+)?`;
const AT_MOST = String.raw`(?:max(?:imum)?(?:\s+of)?|at\s+most|up\s+to|no\s+more\s+than|not\s+more\s+than|less\s+than|fewer\s+than|under|below|<=?|≤)`;

const EXPERIENCE: RegExp[] = [
  // "a maximum of 6 years of experience", "under 5 yrs"
  new RegExp(`${LEAD_IN}${AT_MOST}\\s*${COUNT}${YEARS_OF_EXPERIENCE}(?:\\s+(?:required|needed))?`, 'i'),
  // "3-5 years of experience" → 5
  new RegExp(`${LEAD_IN}\\b(?:\\d{1,2})\\s*(?:-|–|to)\\s*${COUNT}\\s*(?:years?|yrs?)(?:\\s+of)?(?:\\s+(?:experience|exp\\b))?`, 'i'),
  // "6 years of experience (or less)": the searcher's own experience is the most a job may ask for
  new RegExp(`${LEAD_IN}\\b${COUNT}\\+?\\s*(?:years?|yrs?)(?:['’]|\\s+of)?\\s+(?:work\\s+|working\\s+|professional\\s+|relevant\\s+|industry\\s+)?(?:experience|exp\\b)(?:\\s+(?:or\\s+(?:less|fewer)|max(?:imum)?|at\\s+most|tops))?`, 'i'),
  // "experience: max 6 years"
  new RegExp(`\\bexperience\\s*(?:of|:)?\\s*${AT_MOST}?\\s*${COUNT}\\+?\\s*(?:years?|yrs?)`, 'i'),
];

const PAY_LEAD = String.raw`(?:\b(?:and\s+|that\s+|which\s+)?(?:making|makes?|paying|pays?|earning|earns?|with\s+(?:a\s+)?(?:base\s+)?(?:salary|pay|comp(?:ensation)?)(?:\s+of)?|(?:base\s+)?(?:salary|pay|comp(?:ensation)?)(?:\s+of|:)?)\s+)`;
const PAY_FLOOR = String.raw`(?:(at\s+least|a\s+min(?:imum)?(?:\s+of)?|min(?:imum)?(?:\s+of)?|over|above|more\s+than|north\s+of|from|>=?|≥)\s*)`;
const PAY_CEILING = String.raw`(?:(at\s+most|max(?:imum)?(?:\s+of)?|under|below|less\s+than|up\s+to|<=?|≤)\s*)`;
const AMOUNT = String.raw`(?<![\w.])([$£€])?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k\b|thousand\b)?\+?`;
const PAY_UNIT = String.raw`(?:\s*(usd|cad|aud|eur|gbp|dollars|euros|pounds)\b)?(?:\s*(?:\/|per\s+|an?\s+)\s*(year|yr|annum|hour|hr|month|mo)\b|\s+(annually|yearly|hourly|monthly)\b)?(?:\s*(?:\+|or\s+more|and\s+up|minimum|min\b))?`;
const PAY = new RegExp(`(${PAY_LEAD})?(?:${PAY_FLOOR}|${PAY_CEILING})?${AMOUNT}${PAY_UNIT}`, 'gi');
const CURRENCY: Record<string, string> = { $: 'USD', '£': 'GBP', '€': 'EUR', usd: 'USD', dollars: 'USD', cad: 'CAD', aud: 'AUD', eur: 'EUR', euros: 'EUR', gbp: 'GBP', pounds: 'GBP' };

const PLACE_ALIASES: Record<string, string[]> = {
  nyc: ['new york', 'nyc'],
  'new york city': ['new york', 'nyc'],
  sf: ['san francisco', 'sf'],
  'bay area': ['bay area', 'san francisco', 'oakland', 'san jose', 'palo alto', 'mountain view', 'sunnyvale', 'menlo park', 'redwood city'],
  'sf bay area': ['bay area', 'san francisco', 'oakland', 'san jose', 'palo alto', 'mountain view', 'sunnyvale', 'menlo park', 'redwood city'],
  'silicon valley': ['san jose', 'palo alto', 'mountain view', 'sunnyvale', 'menlo park', 'cupertino', 'santa clara'],
  la: ['los angeles'],
  dc: ['washington'],
  'washington dc': ['washington'],
  us: ['united states', 'usa', 'us'],
  usa: ['united states', 'usa', 'us'],
  'united states': ['united states', 'usa', 'us'],
  america: ['united states', 'usa', 'us'],
  uk: ['united kingdom', 'uk'],
  'united kingdom': ['united kingdom', 'uk'],
};

/** Words that qualify the city before them ("Austin, TX", "Austin, Texas") rather than naming another place. */
const REGIONS = new Set(
  ('alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland ' +
    'massachusetts michigan minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington wisconsin wyoming ' +
    'usa us canada uk england germany france')
    .split(' ')
    .concat(['new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'rhode island', 'south carolina', 'south dakota', 'west virginia', 'united states', 'united kingdom']),
);

const PLACE = /\b(?:based\s+in|located\s+in|in\s+or\s+(?:near|around)|in|near|around)\s+(?:the\s+)?(.+?)(?=\s*(?:\||$|\b(?:with|that|which|who|making|paying|requiring|for|at|as|where|on|from)\b))/i;

const LEVELS: [Seniority, RegExp][] = [
  ['intern', /\b(?:interns?|internships?)\b/gi],
  ['entry', /\b(?:junior|jr\.?|entry[\s-]level|new[\s-]grad(?:uate)?s?|graduate)\b/gi],
  ['mid', /\bmid[\s-]?level\b/gi],
  ['senior', /\b(?:senior|sr\.?)(?![\s-]+(?:staff|principal|manager|director))\b/gi],
  ['staff', /\b(?:senior\s+)?staff\b/gi],
  ['principal', /\b(?:senior\s+)?principal\b/gi],
  ['manager', /\b(?:senior\s+)?(?:managers?|management)\b/gi],
  ['director', /\b(?:senior\s+)?(?:directors?|vp|vice\s+president)\b/gi],
];

const STOPWORDS = new Set(
  ('job jobs role roles position positions opening openings listing listings posting postings opportunity opportunities gig gigs work new newly all any every find show watch track monitor ' +
    'notify alert alerts me us my tell let know when whenever about for the a an with that which who are is be in at of and or to i we want wants looking look need needs get please ' +
    'company companies level levels experience experienced years year hiring there posted post open up comes come appears appear available full time fulltime full-time only just also ' +
    'some based located area anywhere everything regardless board boards it its this these those on by from like such as type types kind kinds').split(' '),
);

/** Role nouns that say little on their own: "iOS engineer" should also find "iOS Developer". */
const GENERIC = new Set(['engineer', 'engineers', 'engineering', 'developer', 'developers', 'development', 'dev', 'devs', 'programmer', 'programmers', 'software', 'swe', 'specialist', 'professional']);

/** Postings say "iOS Engineers" or "iOS Engineer"; matching allows a plural, so terms are kept singular. */
const singular = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !/(ios|aws|kubernetes|devops|sales|analytics|operations|success|business|systems|rails|js)$/.test(w) ? w.slice(0, -1) : w);

const uniq = <T>(xs: T[]) => [...new Set(xs)];

function places(phrase: string): string[] {
  const out: string[] = [];
  for (const group of phrase.toLowerCase().split(/\s*(?:\s+or\s+|\s+and\s+|\/|;|&)\s*/)) {
    const parts = group.split(/\s*,\s*/).filter(Boolean);
    parts.forEach((raw, i) => {
      const part = raw.replace(/^(?:the|greater)\s+/, '').replace(/\s+(?:metro(?:politan)?\s+area|metro|area|region)$/, '').replace(/[.!?]+$/, '').trim();
      // "Austin, TX" / "Austin, Texas": the state narrows the city, it is not a second place.
      if (!part || (i > 0 && (part.length <= 2 || REGIONS.has(part)))) return;
      out.push(...(PLACE_ALIASES[part] ?? PLACE_ALIASES[raw.trim()] ?? [part]));
    });
  }
  return uniq(out);
}

export function parseQuery(query: string): ParsedQuery {
  const out: ParsedQuery = { keywords: [], all_keywords: [], exclude_keywords: [], locations: [], seniority: [], remote_only: false, notes: [] };
  let rest = ` ${query.replace(/\s+/g, ' ').trim()} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)}${CUT}${rest.slice(m.index + m[0].length)}`;
    return m;
  };

  // Years of experience first, so its number is never read as pay.
  for (const re of EXPERIENCE) {
    const m = take(re);
    if (!m) continue;
    const raw = m[1]!.toLowerCase();
    out.max_experience_years = COUNT_WORDS[raw] ?? Number(raw);
    break;
  }

  // Pay: "making at least 150k a year", "$150,000+", "$70/hr".
  for (const m of [...rest.matchAll(PAY)]) {
    const [whole, lead, , ceiling, symbol, digits, k, unit, per, adverb] = m;
    let value = Number(digits!.replace(/,/g, '')) * (k ? 1000 : 1);
    const period = /^(hour|hr|hourly)$/i.test(per ?? adverb ?? '') ? 'hour' : /^(month|mo|monthly)$/i.test(per ?? adverb ?? '') ? 'month' : per || adverb ? 'year' : undefined;
    const looksLikePay = Boolean(lead || symbol || k || unit || period || value >= 10_000);
    if (!looksLikePay) continue;
    if (value < 1000 && !period && !k) value *= 1000; // "making at least 150"
    const annual = Math.round(value * (period === 'hour' ? 2080 : period === 'month' ? 12 : 1));
    rest = rest.replace(whole, CUT);
    if (ceiling) {
      out.notes.push(`"${whole.trim()}" reads as a maximum salary, which is not a filter Watchtower has; it was ignored.`);
      continue;
    }
    if (out.min_salary !== undefined || annual < 1000) continue;
    out.min_salary = annual;
    const currency = CURRENCY[(symbol ?? unit ?? '').toLowerCase()];
    if (currency) out.salary_currency = currency;
  }

  // Exclusions: "no managers", "excluding contract".
  for (const m of [...rest.matchAll(/\b(?:not|no|excluding|except|without|minus)\s+(?:any\s+)?([\p{L}\p{N}+#.-]+)/giu)]) {
    const word = singular(m[1]!.toLowerCase().replace(/[.,]+$/, ''));
    if (STOPWORDS.has(word) || word === 'remote') continue;
    out.exclude_keywords.push(word);
    rest = rest.replace(m[0], CUT);
  }

  // Places: "in Austin", "in Austin, TX or remote", "near the Bay Area".
  const place = take(PLACE);
  if (place) {
    const found = places(place[1]!);
    const named = found.filter((p) => p !== 'remote');
    if (named.length) out.locations = found; // "Austin or remote": either location text qualifies
    else if (found.includes('remote')) out.remote_only = true;
  }
  if (/\b(?:fully[\s-]+|100%\s+)?remote(?:[\s-]+(?:only|first|friendly))?\b/i.test(rest)) {
    rest = rest.replace(/\b(?:fully[\s-]+|100%\s+)?remote(?:[\s-]+(?:only|first|friendly))?\b/gi, CUT);
    // "Austin or remote" already lists remote as a location; a bare "remote" means remote only.
    if (out.locations.length) out.locations = uniq([...out.locations, 'remote']);
    else out.remote_only = true;
  }
  for (const m of [...rest.matchAll(/\b(?:hybrid|on[\s-]?site|in[\s-]office|in[\s-]person)\b/gi)]) {
    out.notes.push(`"${m[0]}" is not a filter Watchtower has; it was ignored.`);
    rest = rest.replace(m[0], CUT);
  }

  for (const [level, re] of LEVELS) {
    if (!re.test(rest)) continue;
    re.lastIndex = 0;
    rest = rest.replace(re, ' ');
    out.seniority.push(level);
  }

  // What is left names the role.
  const anyOf = /\s(?:or)\s|\//i.test(rest.replace(/\|/g, ' '));
  const words = rest
    .toLowerCase()
    .split(/[\s,;:|()"“”!?/]+/)
    .map((w) => w.replace(/^[.'’-]+(?=[^.])|[.'’-]+$/g, (edge, offset: number) => (offset === 0 && edge === '.' ? edge : '')))
    .filter((w) => w && /[\p{L}\p{N}]/u.test(w) && !STOPWORDS.has(w))
    .map(singular);
  const specific = uniq(words.filter((w) => !GENERIC.has(w)));
  const generic = uniq(words.filter((w) => GENERIC.has(w)));
  if (specific.length === 0) {
    // Only generic words: keep them together as a phrase ("software engineer").
    if (generic.length) out.keywords = [generic.join(' ')];
  } else if (specific.length === 1 || anyOf) {
    out.keywords = specific.slice(0, 20);
  } else {
    out.all_keywords = specific.slice(0, 20);
  }
  out.seniority = uniq(out.seniority);
  out.exclude_keywords = uniq(out.exclude_keywords);
  return out;
}
