export type AdapterName = 'html' | 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee' | 'workday' | 'icims' | 'apple' | 'google' | 'amazon' | 'microsoft';

/** Job-board platforms read through their own endpoints (as opposed to JobPosting markup on an arbitrary page). */
export const PLATFORM_ADAPTERS: ReadonlySet<AdapterName> = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'recruitee', 'workday', 'icims', 'apple', 'google', 'amazon', 'microsoft']);

export const SENIORITIES = ['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'manager', 'director'] as const;
export type Seniority = (typeof SENIORITIES)[number];

export type SalaryPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';

/** A stated pay range. `annual_*` is the same range converted to a yearly figure, which is what filters compare. */
export interface Salary {
  min?: number;
  max?: number;
  currency?: string;
  period: SalaryPeriod;
  annual_min?: number;
  annual_max?: number;
}

export interface JobItem {
  key: string;
  title: string;
  location?: string;
  department?: string;
  company?: string;
  url?: string;
  posted_at?: string;
  source: Exclude<AdapterName, 'html'> | 'jsonld';
  /** Further locations the posting lists besides `location`. Location filters match these too. */
  other_locations?: string[];
  /** Stated pay, from the platform's structured field or the posting text. Absent when the posting states none. */
  salary?: Salary;
  /** Minimum years of experience the posting asks for. Absent when it states none. */
  experience_years?: number;
  /** Derived from the title and location; see classify(). */
  remote?: boolean;
  seniority?: Seniority;
  /** Only the URL was seen (iCIMS or Google sitemap): the title is derived from the slug and the location is unknown. */
  partial?: boolean;
}

export interface Extraction {
  jobs: JobItem[];
  /** False when the source only exposed the newest postings, so absence from the list does not mean removal. */
  complete?: boolean;
}
