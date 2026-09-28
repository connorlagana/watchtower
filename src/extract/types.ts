export type AdapterName = 'html' | 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee';

export const API_ADAPTERS: ReadonlySet<AdapterName> = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'recruitee']);

export interface JobItem {
  key: string;
  title: string;
  location?: string;
  department?: string;
  company?: string;
  url?: string;
  posted_at?: string;
  source: 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee' | 'jsonld';
}

export interface EventItem {
  key: string;
  name: string;
  start_date?: string;
  end_date?: string;
  location?: string;
  url?: string;
  status?: string;
  /** "jsonld" = schema.org Event markup; "text" = a date found in page text (fallback). */
  source: 'jsonld' | 'text';
}

/** An RSS/Atom entry. */
export interface FeedItem {
  key: string;
  title: string;
  url?: string;
  published_at?: string;
  summary?: string;
}

export interface Extraction {
  title: string | null;
  /** Normalized, line-oriented text used for CONTENT_CHANGED diffs. */
  text: string;
  jobs: JobItem[];
  events: EventItem[];
  /** RSS/Atom entries; when present the resource is a feed and reports ITEM_ADDED instead of text diffs. */
  items?: FeedItem[];
  isFeed?: boolean;
}
