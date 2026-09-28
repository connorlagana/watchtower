/**
 * Minimal robots.txt support (RFC 9309): user-agent groups, Allow/Disallow
 * with longest-match precedence, `*` and `$` wildcards.
 */
import { FetchError, safeFetch, type FetchOptions } from './safeFetch.js';

export const ROBOTS_AGENT_TOKEN = 'watchtowerbot';

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  rules: Rule[];
  /** When true everything is disallowed (e.g. robots.txt returned 5xx). */
  disallowAll?: boolean;
}

export function parseRobots(text: string, agentToken = ROBOTS_AGENT_TOKEN): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      // An empty Disallow means "allow everything"; it contributes no rule.
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && agentToken.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules) };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function isAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  if (rules.disallowAll) return false;
  let best: Rule | null = null;
  for (const rule of rules.rules) {
    if (!patternToRegex(rule.pattern).test(pathWithQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { rules: RobotsRules; expires: number }>();

/** Fetch (cached per origin) and evaluate robots.txt for a URL. */
export async function robotsAllows(target: string, opts: FetchOptions): Promise<boolean> {
  const url = new URL(target);
  const origin = url.origin;
  let entry = cache.get(origin);
  if (!entry || entry.expires < Date.now()) {
    let rules: RobotsRules;
    try {
      const res = await safeFetch(`${origin}/robots.txt`, { ...opts, maxBytes: Math.min(opts.maxBytes, 512 * 1024) });
      if (res.status >= 200 && res.status < 300) rules = parseRobots(res.body);
      else if (res.status >= 500) rules = { rules: [], disallowAll: true };
      else rules = { rules: [] }; // 4xx: no robots.txt, everything allowed
    } catch (err) {
      // Unreachable robots.txt: RFC 9309 says treat as full disallow, except
      // for content problems (e.g. the site serves HTML/binary) which mean "no rules".
      if (err instanceof FetchError && (err.code === 'UNSUPPORTED_CONTENT_TYPE' || err.code === 'BODY_TOO_LARGE')) rules = { rules: [] };
      else throw err;
    }
    entry = { rules, expires: Date.now() + CACHE_TTL_MS };
    cache.set(origin, entry);
    if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  }
  return isAllowed(entry.rules, url.pathname + url.search);
}

export function clearRobotsCache(): void {
  cache.clear();
}
