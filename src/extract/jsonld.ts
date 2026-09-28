/**
 * schema.org JSON-LD extraction for JobPosting and Event (and Event subtypes
 * such as MusicEvent, BusinessEvent, ...).
 */
import type { EventItem, JobItem } from './types.js';

type Node = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const o = v as Node;
    return str(o.name) ?? str(o['@value']) ?? str(o.value) ?? str(o['@id']);
  }
  return undefined;
}

function types(node: Node): string[] {
  return asArray(node['@type'] as string | string[]).map((t) => String(t).replace(/^.*[/#:]/, ''));
}

/** Parse every <script type="application/ld+json"> payload, tolerating common junk. */
export function parseJsonLdBlocks(blocks: string[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of blocks) {
    const cleaned = raw
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '')
      .replace(/;\s*$/, '')
      .trim();
    if (!cleaned) continue;
    try {
      out.push(JSON.parse(cleaned));
    } catch {
      // Some sites emit raw newlines inside strings; try once more with them escaped.
      try {
        out.push(JSON.parse(cleaned.replace(/[\n\r\t]+/g, ' ')));
      } catch {
        /* unparseable block: ignore */
      }
    }
  }
  return out;
}

/** Walk arbitrary JSON-LD and yield every object node, including nested @graph / ItemList / subEvent. */
function* walk(value: unknown, depth = 0): Generator<Node> {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) yield* walk(v, depth + 1);
    return;
  }
  const node = value as Node;
  yield node;
  for (const key of ['@graph', 'itemListElement', 'item', 'subEvent', 'subEvents', 'event', 'events', 'mainEntity']) {
    if (key in node) yield* walk(node[key], depth + 1);
  }
}

function placeText(v: unknown): string | undefined {
  const parts: string[] = [];
  for (const place of asArray(v as Node | Node[])) {
    if (typeof place === 'string') {
      parts.push(place);
      continue;
    }
    if (!place || typeof place !== 'object') continue;
    const p = place as Node;
    if (types(p).includes('VirtualLocation')) {
      parts.push('Online');
      continue;
    }
    const addr = p.address as Node | string | undefined;
    const addrText =
      typeof addr === 'string'
        ? addr
        : addr
          ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].map(str).filter(Boolean).join(', ')
          : '';
    const name = str(p.name);
    parts.push([name, addrText].filter(Boolean).join(', '));
  }
  const joined = parts.filter(Boolean).join(' / ');
  return joined || undefined;
}

export function extractJsonLd(docs: unknown[], baseUrl?: string): { jobs: JobItem[]; events: EventItem[] } {
  const jobs = new Map<string, JobItem>();
  const events = new Map<string, EventItem>();
  const abs = (u?: string) => {
    if (!u) return undefined;
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return u;
    }
  };

  for (const doc of docs) {
    for (const node of walk(doc)) {
      const t = types(node);
      if (t.includes('JobPosting')) {
        const title = str(node.title) ?? str(node.name);
        if (!title) continue;
        const remote = String(node.jobLocationType ?? '').toUpperCase().includes('TELECOMMUTE');
        const location = [placeText(node.jobLocation), remote ? 'Remote' : undefined].filter(Boolean).join(' / ') || undefined;
        const url = abs(str(node.url));
        const id = str(node.identifier);
        const key = `job:${id ?? url ?? `${title}|${location ?? ''}`}`.toLowerCase();
        jobs.set(key, {
          key,
          title,
          location,
          company: str(node.hiringOrganization),
          department: str(node.occupationalCategory) ?? str(node.industry),
          url,
          posted_at: str(node.datePosted),
          source: 'jsonld',
        });
      } else if (t.some((x) => x === 'Event' || x.endsWith('Event'))) {
        const name = str(node.name);
        if (!name) continue;
        const start = str(node.startDate);
        const url = abs(str(node.url));
        const key = `event:${url ?? name}|${start ?? ''}`.toLowerCase();
        events.set(key, {
          key,
          name,
          start_date: start,
          end_date: str(node.endDate),
          location: placeText(node.location),
          url,
          status: str(node.eventStatus)?.replace(/^.*\//, ''),
          source: 'jsonld',
        });
      }
    }
  }
  return { jobs: [...jobs.values()], events: [...events.values()] };
}
