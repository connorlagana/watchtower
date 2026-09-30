/**
 * Derived job attributes that agents filter on: remote status and seniority.
 * Both come from the title and location text only, so they are the same for
 * every source and never depend on platform-specific fields.
 */
import type { JobItem, Seniority } from './types.js';

const REMOTE = /\b(remote|telecommute|telework|work from home|wfh|anywhere)\b/i;
const NOT_REMOTE = /\b(no|not|non)[\s-]*(remote|telework|telecommute)|\bon[\s-]?site\b|\bhybrid\b/i;

/** Ordered: the first matching level wins. Management titles beat IC-level words ("Senior Engineering Manager" is a manager). */
const LEVELS: [Seniority, RegExp][] = [
  ['intern', /\b(intern|internship|co-op|coop|working student|apprentice)\b/i],
  ['director', /\b(director|vp|vice president|chief|head of|cto|cfo|ceo|coo|president)\b/i],
  ['manager', /\b(manager|mgr|supervisor)\b/i],
  ['principal', /\b(principal|distinguished|fellow|architect)\b/i],
  ['staff', /\bstaff\b/i],
  ['senior', /\b(senior|sr\.?|lead|iii|iv)\b/i],
  ['entry', /\b(junior|jr\.?|entry[\s-]level|new grad(uate)?|graduate|associate|trainee|i)\b/i],
];

export function seniorityOf(title: string): Seniority {
  for (const [level, re] of LEVELS) if (re.test(title)) return level;
  return 'mid';
}

export function isRemote(title: string, location?: string): boolean {
  const text = `${title} ${location ?? ''}`;
  return REMOTE.test(text) && !NOT_REMOTE.test(text);
}

/** Fill in the derived fields on every job. Applied once by extract(), never by callers. */
export function classify(jobs: JobItem[]): JobItem[] {
  return jobs.map((j) => ({ ...j, remote: isRemote(j.title, j.location), seniority: seniorityOf(j.title) }));
}
