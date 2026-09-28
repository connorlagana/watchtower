export type AdapterName = 'html' | 'greenhouse' | 'lever';

export interface JobItem {
  key: string;
  title: string;
  location?: string;
  department?: string;
  company?: string;
  url?: string;
  posted_at?: string;
  source: 'greenhouse' | 'lever' | 'jsonld';
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

export interface Extraction {
  title: string | null;
  /** Normalized, line-oriented text used for CONTENT_CHANGED diffs. */
  text: string;
  jobs: JobItem[];
  events: EventItem[];
}
