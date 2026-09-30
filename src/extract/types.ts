export type AdapterName = 'html' | 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee' | 'workday' | 'icims';

/** Job-board platforms read through their own endpoints (as opposed to JobPosting markup on an arbitrary page). */
export const PLATFORM_ADAPTERS: ReadonlySet<AdapterName> = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'recruitee', 'workday', 'icims']);

export const SENIORITIES = ['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'manager', 'director'] as const;
export type Seniority = (typeof SENIORITIES)[number];

export interface JobItem {
  key: string;
  title: string;
  location?: string;
  department?: string;
  company?: string;
  url?: string;
  posted_at?: string;
  source: Exclude<AdapterName, 'html'> | 'jsonld';
  /** Derived from the title and location; see classify(). */
  remote?: boolean;
  seniority?: Seniority;
  /** Only the URL was seen (iCIMS sitemap): the title is derived from the slug and the location is unknown. */
  partial?: boolean;
}

export interface Extraction {
  jobs: JobItem[];
  /** False when the source only exposed the newest postings, so absence from the list does not mean removal. */
  complete?: boolean;
}
