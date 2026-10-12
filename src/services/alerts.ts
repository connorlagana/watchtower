/**
 * Daily email digests for website accounts: the new postings each saved search has matched since the last email.
 * Sent through Resend when RESEND_API_KEY is set; otherwise nothing runs and /alerts is the only place they show.
 */
import type { JobItem } from '../extract/types.js';
import type { Ctx } from './context.js';
import { getChanges } from './watches.js';

const TICK_MS = 15 * 60_000;
const BATCH = 50;
const MAX_JOBS_PER_EMAIL = 20;

interface DueUser {
  id: string;
  email: string;
  client_id: string;
}

/** Sends every due digest once. Returns how many emails went out. Safe on several replicas (advisory-locked). */
export async function sendDueDigests(ctx: Ctx, send = resendSend): Promise<number> {
  if (!ctx.config.resendApiKey && send === resendSend) return 0;
  const conn = await ctx.db.connect();
  let sent = 0;
  try {
    const { rows: lock } = await conn.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(727276) AS locked');
    if (!lock[0]?.locked) return 0;
    try {
      const { rows: users } = await conn.query<DueUser>(
        `SELECT u.id, u.email, u.client_id FROM users u
          WHERE u.email_alerts AND u.client_id IS NOT NULL
            AND (u.last_alert_at IS NULL OR u.last_alert_at < now() - interval '23 hours')
            AND EXISTS (SELECT 1 FROM watches w WHERE w.client_id = u.client_id AND w.deleted_at IS NULL)
          ORDER BY u.last_alert_at NULLS FIRST LIMIT $1`,
        [BATCH],
      );
      for (const u of users) {
        try {
          if (await digestFor(ctx, u, send)) sent++;
        } catch (err) {
          ctx.log.warn({ err: (err as Error).message, user: u.id }, 'alert digest failed');
        }
      }
    } finally {
      await conn.query('SELECT pg_advisory_unlock(727276)');
    }
  } finally {
    conn.release();
  }
  return sent;
}

async function digestFor(ctx: Ctx, u: DueUser, send: Sender): Promise<boolean> {
  const client = { id: u.client_id, created_at: new Date() };
  const { rows: watches } = await ctx.db.query<{ id: string; label: string | null; query: string | null; notified_cursor: number | null; baseline: number }>(
    'SELECT id, label, query, notified_cursor, baseline FROM watches WHERE client_id = $1 AND deleted_at IS NULL AND resource_id IS NULL ORDER BY created_at',
    [u.client_id],
  );
  const sections: { title: string; jobs: JobItem[] }[] = [];
  const advance: [string, number][] = [];
  for (const w of watches) {
    // peek: the in-app "new" badge keeps its own cursor; reading here also renews the watch.
    const res = await getChanges(ctx, client, { watch_id: w.id, since: w.notified_cursor ?? w.baseline, peek: true, limit: 200 });
    advance.push([w.id, res.cursor]);
    const jobs = res.changes.filter((c) => c.type === 'JOB_ADDED').map((c) => (c.data as { job: JobItem }).job).filter(Boolean);
    if (jobs.length) sections.push({ title: w.label || w.query || 'Saved search', jobs });
  }
  for (const [id, cursor] of advance) await ctx.db.query('UPDATE watches SET notified_cursor = GREATEST(coalesce(notified_cursor, 0), $2) WHERE id = $1', [id, cursor]);
  await ctx.db.query('UPDATE users SET last_alert_at = now() WHERE id = $1', [u.id]);
  if (!sections.length) return false;
  const total = sections.reduce((n, s) => n + s.jobs.length, 0);
  await send(ctx, {
    to: u.email,
    subject: total === 1 ? `1 new job: ${sections[0]!.jobs[0]!.title}` : `${total} new jobs match your Watchtower searches`,
    html: digestHtml(ctx.config.publicBaseUrl, sections),
  });
  return true;
}

export interface Email {
  to: string;
  subject: string;
  html: string;
}
export type Sender = (ctx: Ctx, email: Email) => Promise<void>;

async function resendSend(ctx: Ctx, email: Email): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.config.resendApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: ctx.config.alertsFrom, to: [email.to], subject: email.subject, html: email.html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function formatPay(job: Pick<JobItem, 'salary'>): string | null {
  const s = job.salary;
  if (!s) return null;
  const lo = s.annual_min ?? s.min;
  const hi = s.annual_max ?? s.max;
  const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
  const sym = !s.currency || s.currency === 'USD' ? '$' : `${s.currency} `;
  if (lo && hi && lo !== hi) return `${sym}${k(lo)}–${k(hi)}`;
  const one = hi ?? lo;
  return one ? `${sym}${k(one)}` : null;
}

function digestHtml(base: string, sections: { title: string; jobs: JobItem[] }[]): string {
  let left = MAX_JOBS_PER_EMAIL;
  const body = sections
    .map((s) => {
      const shown = s.jobs.slice(0, Math.max(left, 0));
      left -= shown.length;
      if (!shown.length) return '';
      const rows = shown
        .map((j) => {
          const pay = formatPay(j);
          const meta = [j.company, j.location].filter(Boolean).join(' · ');
          return `<tr><td style="padding:12px 0;border-top:1px solid #e6e4de">
            <a href="${esc(j.url ?? `${base}/jobs`)}" style="color:#1c1c1a;font-weight:600;text-decoration:none;font-size:16px">${esc(j.title)}</a>
            <div style="color:#56554f;font-size:14px;margin-top:2px">${esc(meta)}${pay ? ` · <b style="color:#4a7212">${esc(pay)}</b>` : ''}</div></td></tr>`;
        })
        .join('');
      return `<h2 style="font:600 15px system-ui,sans-serif;color:#56554f;margin:28px 0 4px">${esc(s.title)} · ${s.jobs.length} new</h2><table width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui,sans-serif">${rows}</table>`;
    })
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#f8f7f4"><div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:system-ui,sans-serif;color:#1c1c1a">
  <div style="font-size:15px;font-weight:600">● Watchtower</div>
  <h1 style="font:400 28px Georgia,serif;margin:18px 0 0">New jobs since yesterday</h1>
  ${body}
  <p style="margin:32px 0 0"><a href="${esc(base)}/alerts" style="display:inline-block;background:#6cb200;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open your alerts</a></p>
  <p style="color:#69685f;font-size:12px;margin-top:28px">You get this because you saved a search on Watchtower. <a href="${esc(base)}/alerts" style="color:#69685f">Turn off emails</a>.</p>
</div></body></html>`;
}

export function startAlerts(ctx: Ctx): { stop: () => void } {
  if (!ctx.config.resendApiKey) return { stop: () => {} };
  const run = () => void sendDueDigests(ctx).then((n) => n && ctx.log.info({ sent: n }, 'alert digests sent')).catch((err) => ctx.log.error({ err }, 'alert digests failed'));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, TICK_MS);
  timer.unref();
  first.unref();
  return { stop: () => (clearTimeout(first), clearInterval(timer)) };
}
