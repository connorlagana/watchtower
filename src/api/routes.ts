import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, bearerToken, clientOrigin, createClient } from '../services/clients.js';
import { countDaily, recordUse } from '../services/usage.js';
import type { LimitSpec } from '../services/rateLimit.js';
import { listCompanies, MAX_COMPANIES_LIMIT } from '../services/companies.js';
import { AppError, type Ctx } from '../services/context.js';
import { SENIORITIES } from '../extract/types.js';
import { ackChanges, checkNow, createSearchWatch, createWatch, createWatches, deleteWatch, getChanges, getWatch, listWatches, MAX_BATCH_URLS, MAX_SEARCH_LIMIT, searchJobs } from '../services/watches.js';

const filterFields = {
  // What to look for, in plain language. Read into the filters below; explicit filters win.
  query: z.string().min(1).max(500).optional(),
  keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
  all_keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
  exclude_keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
  locations: z.array(z.string().min(1).max(100)).max(20).optional(),
  seniority: z.array(z.enum(SENIORITIES)).optional(),
  remote_only: z.boolean().optional(),
  min_salary: z.number().min(0).max(100_000_000).optional(),
  salary_currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  max_experience_years: z.number().min(0).max(60).optional(),
  include_unknown: z.boolean().optional(),
};

const createWatchBody = z
  .object({
    // Optional; every watch is a job watch. Accepted for clients written against the earlier multi-type API.
    type: z.literal('jobs').optional(),
    url: z.string().url().max(2048).optional(),
    urls: z.array(z.string().url().max(2048)).min(1).max(MAX_BATCH_URLS).optional(),
    ...filterFields,
    interval_minutes: z.number().int().min(1).max(10080).optional(),
    label: z.string().max(200).optional(),
    webhook_url: z.string().url().max(2048).optional(),
  })
  // Neither url nor urls: a search watch across every monitored board.
  .refine((b) => b.url === undefined || b.urls === undefined, { message: 'pass url or urls, not both' });

const searchBody = z.object({
  ...filterFields,
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

const companiesQuery = z.object({
  q: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_COMPANIES_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ackBody = z.object({
  cursor: z.number().int().min(0),
  watch_id: z.string().uuid().optional(),
});

const changesQuery = z.object({
  watch_id: z.string().uuid().optional(),
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  peek: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new AppError(400, 'VALIDATION_ERROR', msg);
  }
  return r.data;
}

export async function registerApiRoutes(app: FastifyInstance, ctx: Ctx, opts: { clientCreationPerHour: number; searchLimit: LimitSpec }) {
  /** Authenticates the caller and records the call in the usage history, under the matching MCP tool's name. */
  const auth = async (req: FastifyRequest, tool: string) => {
    const client = await authenticate(ctx, bearerToken(req.headers.authorization));
    await recordUse(ctx, client.id, tool, 'rest');
    return client;
  };

  app.post(
    '/v1/clients',
    { config: { limit: { name: 'client_creation', max: opts.clientCreationPerHour, windowSeconds: 3600 } } },
    async (req, reply) => {
      const { client, token } = await createClient(ctx, clientOrigin(req.query, req.headers['user-agent']));
      reply.code(201);
      return {
        client_id: client.id,
        token,
        max_watches: ctx.config.maxWatchesPerClient,
        note: 'Store this token; it is shown only once. Send it as "Authorization: Bearer <token>".',
      };
    },
  );

  app.post('/v1/watches', async (req, reply) => {
    const client = await auth(req, 'watch_jobs');
    const { type: _type, url, urls, ...body } = parse(createWatchBody, req.body);
    reply.code(201);
    if (urls) return createWatches(ctx, client, { ...body, urls });
    if (url) return createWatch(ctx, client, { ...body, url });
    return createSearchWatch(ctx, client, body);
  });

  // Read-only and tokenless: the jobs open right now that match. A token, if sent, is checked and the call counted for it.
  app.post('/v1/jobs/search', { config: { limit: opts.searchLimit } }, async (req) => {
    const body = parse(searchBody, req.body ?? {});
    if (req.headers.authorization) await auth(req, 'search_jobs');
    else await countDaily(ctx, 'anonymous_search', 'rest:search_jobs');
    return searchJobs(ctx, body);
  });

  app.get('/v1/companies', { config: { limit: opts.searchLimit } }, async (req) => {
    const { q, ...page } = parse(companiesQuery, req.query);
    if (req.headers.authorization) await auth(req, 'list_companies');
    else await countDaily(ctx, 'anonymous_search', 'rest:list_companies');
    return listCompanies(ctx, { query: q, ...page });
  });

  app.get('/v1/watches', async (req) => listWatches(ctx, await auth(req, 'list_watches')));

  app.get<{ Params: { id: string } }>('/v1/watches/:id', async (req) => getWatch(ctx, await auth(req, 'get_watch'), req.params.id));

  app.delete<{ Params: { id: string } }>('/v1/watches/:id', async (req) => deleteWatch(ctx, await auth(req, 'delete_watch'), req.params.id));

  app.post<{ Params: { id: string } }>(
    '/v1/watches/:id/check',
    { config: { limit: { name: 'check_now', max: 10, windowSeconds: 60 } } },
    async (req) => checkNow(ctx, await auth(req, 'check_now'), req.params.id),
  );

  app.get('/v1/changes', async (req) => {
    const q = parse(changesQuery, req.query);
    return getChanges(ctx, await auth(req, 'get_changes'), q);
  });

  app.post('/v1/changes/ack', async (req) => {
    const body = parse(ackBody, req.body);
    return ackChanges(ctx, await auth(req, 'ack_changes'), body);
  });
}
