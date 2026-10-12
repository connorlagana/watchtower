/**
 * The website app: /jobs (search), /signin, /signup, /alerts, and the JSON endpoints under /web their pages call.
 * Signed-out visitors see the first few results of a search; the rest needs a free account. That limit is enforced
 * here, not in the page: a signed-out search never returns more than FREE_RESULTS jobs or any page past the first.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JobItem } from '../extract/types.js';
import { AppError, type Ctx } from '../services/context.js';
import type { LimitSpec } from '../services/rateLimit.js';
import { countDaily, recordUse } from '../services/usage.js';
import {
  createSession,
  deleteUser,
  endSession,
  sessionUser,
  SESSION_COOKIE,
  SESSION_DAYS,
  setEmailAlerts,
  signIn,
  signUp,
  userClient,
  type User,
} from '../services/users.js';
import { createSearchWatch, deleteWatch, getChanges, listWatches, searchJobs, type SearchJobsInput } from '../services/watches.js';
import { alertsPage, authPage, HIGH_PAY, jobsPage, type AlertRow } from '../web/jobs.js';

const PAGE_SIZE = 20;

const searchBody = z.object({
  query: z.string().trim().min(1).max(300).optional(),
  pay300: z.boolean().optional(),
  remote: z.boolean().optional(),
  offset: z.number().int().min(0).max(5000).optional(),
});
const credentials = z.object({ email: z.string().max(320), password: z.string().max(400) });
const emailBody = z.object({ on: z.boolean() });

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new AppError(400, 'VALIDATION_ERROR', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Only same-site paths, so ?next= can never send someone to another site. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])[A-Za-z0-9/?&=%._~+-]{0,500}$/.test(next) ? next : '/jobs';
}

/**
 * With nothing typed, the page shows tech roles: the directory also carries company boards with sales, medical and
 * other roles, and "$300k+" alone would lead with those.
 */
export const TECH_ROLES = ['engineer', 'engineering', 'developer', 'scientist', 'architect', 'researcher', 'product manager', 'designer', 'sre', 'devops', 'machine learning', 'data'];
const NOT_TECH = ['physician', 'nurse', 'sales', 'account executive'];

/** Filters a search on the page stands for. */
function filtersOf(b: { query?: string; pay300?: boolean; remote?: boolean }): SearchJobsInput {
  return {
    ...(b.query ? { query: b.query } : { keywords: TECH_ROLES, exclude_keywords: NOT_TECH }),
    // "$300k+ only" keeps postings whose stated range reaches $300k; postings with no stated pay are left out.
    ...(b.pay300 ? { min_salary: HIGH_PAY, salary_currency: 'USD', include_unknown: false } : {}),
    ...(b.remote ? { remote_only: true } : {}),
  };
}

function labelOf(b: { query?: string; pay300?: boolean; remote?: boolean }): string {
  const parts = [b.query ?? 'Tech jobs', b.remote ? 'remote' : '', b.pay300 ? '$300k+' : ''].filter(Boolean);
  return parts.join(' · ').slice(0, 200);
}

/** A job as the page shows it: only the fields it renders. */
const slim = (j: JobItem) => ({
  title: j.title,
  company: j.company,
  location: j.location,
  url: j.url,
  posted_at: j.posted_at,
  salary: j.salary,
  remote: j.remote,
  seniority: j.seniority,
  experience_years: j.experience_years,
});

export async function registerWebRoutes(app: FastifyInstance, ctx: Ctx, opts: { searchLimit: LimitSpec; signupPerHour: number }) {
  const secure = ctx.config.publicBaseUrl.startsWith('https://');
  const baseOrigin = new URL(ctx.config.publicBaseUrl).origin;

  const viewer = (req: FastifyRequest) => sessionUser(ctx, readCookie(req.headers.cookie, SESSION_COOKIE));
  const requireUser = async (req: FastifyRequest): Promise<User> => {
    const u = await viewer(req);
    if (!u) throw new AppError(401, 'SIGN_IN_REQUIRED', 'Sign in to do that.');
    return u;
  };
  const setSession = (reply: FastifyReply, token: string) =>
    reply.header('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
  const clearSession = (reply: FastifyReply) => reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  const html = (reply: FastifyReply, body: string) => reply.type('text/html; charset=utf-8').header('cache-control', 'private, no-store').send(body);

  // Cross-site form posts can't carry JSON without a CORS preflight, and SameSite=Lax keeps the cookie off them anyway;
  // checking Origin as well covers older browsers.
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'POST' || !req.url.startsWith('/web/')) return;
    const origin = req.headers.origin;
    if (origin && origin !== baseOrigin && !(ctx.config.allowPrivateNetworks && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      throw new AppError(403, 'FORBIDDEN', 'cross-site request refused');
    }
  });

  // The number on the page: open postings whose stated pay reaches $300k. A full scan, so cached.
  let highPay: { at: number; count: number | null; boards: number } | null = null;
  const pageInfo = async () => {
    if (!highPay || Date.now() - highPay.at > 10 * 60_000) {
      try {
        const r = await searchJobs(ctx, { ...filtersOf({ pay300: true }), limit: 1 });
        highPay = { at: Date.now(), count: r.total, boards: r.coverage.boards };
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message }, 'high-pay count failed');
        highPay = { at: Date.now(), count: null, boards: highPay?.boards ?? 0 };
      }
    }
    return { highPayCount: highPay.count, boards: highPay.boards, freeResults: ctx.config.freeResults, emailAlerts: !!ctx.config.resendApiKey };
  };

  // --- pages -------------------------------------------------------------------
  app.get('/jobs', async (req, reply) => {
    const u = await viewer(req);
    return html(reply, jobsPage(await pageInfo(), u ? { email: u.email } : null));
  });
  for (const mode of ['signin', 'signup'] as const) {
    app.get(`/${mode}`, async (req, reply) => {
      const next = safeNext((req.query as { next?: unknown }).next);
      const u = await viewer(req);
      if (u) return reply.redirect(next);
      return html(reply, authPage(mode, next, null));
    });
  }
  app.get('/alerts', async (req, reply) => {
    const u = await viewer(req);
    if (!u) return reply.redirect('/signin?next=%2Falerts');
    const client = await userClient(ctx, u);
    const { watches } = await listWatches(ctx, client);
    // Saved searches only; a board watch made through the API with the same client is left out.
    const alerts = (watches as unknown as (AlertRow & { scope: string })[]).filter((w) => w.scope === 'all_boards');
    return html(reply, alertsPage({ email: u.email, emailAlerts: u.email_alerts }, alerts, !!ctx.config.resendApiKey));
  });

  // --- account -------------------------------------------------------------------
  app.post('/web/signup', { config: { limit: { name: 'web_signup', max: opts.signupPerHour, windowSeconds: 3600 } } }, async (req, reply) => {
    const body = parse(credentials, req.body);
    const ref = (req.query as { ref?: unknown }).ref;
    const user = await signUp(ctx, {
      ...body,
      source: typeof ref === 'string' && /^[a-z0-9][a-z0-9._-]{0,30}$/i.test(ref) ? `web:${ref.toLowerCase()}` : 'web',
      userAgent: req.headers['user-agent']?.slice(0, 200) ?? null,
    });
    setSession(reply, await createSession(ctx, user.id));
    await countDaily(ctx, 'web_signup', 'email');
    reply.code(201);
    return { ok: true };
  });

  app.post('/web/signin', { config: { limit: { name: 'web_signin', max: 20, windowSeconds: 900 } } }, async (req, reply) => {
    const user = await signIn(ctx, parse(credentials, req.body));
    setSession(reply, await createSession(ctx, user.id));
    return { ok: true };
  });

  // A plain form post from the nav, so it answers with a redirect.
  app.post('/web/signout', async (req, reply) => {
    await endSession(ctx, readCookie(req.headers.cookie, SESSION_COOKIE));
    clearSession(reply);
    return reply.redirect('/jobs', 303);
  });

  app.post('/web/account/email', async (req) => {
    const u = await requireUser(req);
    const { on } = parse(emailBody, req.body);
    await setEmailAlerts(ctx, u, on);
    return { ok: true, email_alerts: on };
  });

  app.post('/web/account/delete', async (req, reply) => {
    const u = await requireUser(req);
    await deleteUser(ctx, u);
    clearSession(reply);
    return { ok: true };
  });

  // --- search ----------------------------------------------------------------------
  app.post('/web/search', { config: { limit: opts.searchLimit } }, async (req) => {
    const body = parse(searchBody, req.body);
    const u = await viewer(req);
    const free = ctx.config.freeResults;
    const offset = u ? (body.offset ?? 0) : 0;
    if (!u && (body.offset ?? 0) > 0) throw new AppError(401, 'SIGN_IN_REQUIRED', 'Sign up free to see more results.');
    const r = await searchJobs(ctx, { ...filtersOf(body), limit: u ? PAGE_SIZE : free, offset });
    if (u) await recordUse(ctx, (await userClient(ctx, u)).id, 'search_jobs', 'rest');
    await countDaily(ctx, 'web_search', u ? 'signed_in' : 'signed_out');
    return {
      total: r.total,
      filters: r.filters,
      notes: r.interpreted?.notes ?? [],
      jobs: r.jobs.map(slim),
      next_offset: u ? r.next_offset : null,
      locked: !u && r.total > free,
      signed_in: !!u,
    };
  });

  // --- alerts (saved searches) -------------------------------------------------------
  app.post('/web/alerts', async (req, reply) => {
    const u = await requireUser(req);
    const body = parse(searchBody.omit({ offset: true }), req.body);
    const client = await userClient(ctx, u);
    const watch = await createSearchWatch(ctx, client, { ...filtersOf(body), label: labelOf(body) });
    await recordUse(ctx, client.id, 'watch_jobs', 'rest');
    await countDaily(ctx, 'web_alert', 'created');
    reply.code(201);
    return { ok: true, id: (watch as { id: string }).id };
  });

  // The new matches of one saved search; reading them marks them seen.
  app.post<{ Params: { id: string } }>('/web/alerts/:id/new', async (req) => {
    const u = await requireUser(req);
    const client = await userClient(ctx, u);
    const res = await getChanges(ctx, client, { watch_id: req.params.id, limit: 200 });
    await recordUse(ctx, client.id, 'get_changes', 'rest');
    const jobs = res.changes
      .filter((c) => c.type === 'JOB_ADDED')
      .map((c) => (c.data as { job?: JobItem }).job)
      .filter((j): j is JobItem => !!j)
      .reverse()
      .map(slim);
    return { jobs };
  });

  app.post<{ Params: { id: string } }>('/web/alerts/:id/delete', async (req) => {
    const u = await requireUser(req);
    await deleteWatch(ctx, await userClient(ctx, u), req.params.id);
    return { ok: true };
  });
}
