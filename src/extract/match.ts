/**
 * Term matching shared by every filter: a term matches as a whole word
 * (case-insensitive, optional plural), so "ios" matches "Senior iOS Engineer"
 * but not "Studios", and "java" does not match "JavaScript".
 * The SQL twin is wt_term_match() (migrations/005_search.sql).
 */
const cache = new Map<string, RegExp>();

export function termMatch(text: string, term: string): boolean {
  let re = cache.get(term);
  if (!re) {
    if (cache.size > 5000) cache.clear();
    const escaped = term.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(s|es)?($|[^\\p{L}\\p{N}])`, 'u');
    cache.set(term, re);
  }
  return re.test(text);
}
