import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApiRoutes } from './api/routes.js';
import { authChallenge, registerOAuthRoutes } from './api/oauth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildMcpServer } from './mcp/server.js';
import { authenticate, bearerToken, clientOrigin } from './services/clients.js';
import { AppError, type Ctx } from './services/context.js';
import { metrics, renderMetrics } from './services/metrics.js';
import { clientBucket, enforce, hit, registerRateLimits } from './services/rateLimit.js';
import { agentClass, countDaily, loadStats } from './services/usage.js';
import { loadCompanies } from './services/companies.js';
import { statsPage } from './web/stats.js';
import { companiesPage, docsPage, FONT_FILES, homepage, llmsTxt, privacyPage, termsPage, robotsTxt, serverCard, wellKnown } from './web/site.js';

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(config: Config, db: Db, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy,
  });
  const ctx: Ctx = { db, config, log: app.log };

  registerRateLimits(app, db, { name: 'global', max: config.rateLimitPerMinute, windowSeconds: 60 });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  // Daily view counts for the public pages, split into people, AI assistants and other bots. Nothing per visitor is kept.
  const countedPages = new Set(['/', '/companies', '/llms.txt', '/privacy', '/terms', '/robots.txt', '/.well-known/watchtower.json', '/.well-known/mcp.json', '/.well-known/mcp-server-card']);
  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (req.method === 'GET' && reply.statusCode === 200 && countedPages.has(path)) {
      await countDaily(ctx, 'page_view', `${path}|${agentClass(req.headers['user-agent'])}`);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({
      error: status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL_ERROR' : (err.code ?? 'BAD_REQUEST'),
      message: status >= 500 ? 'internal error' : err.message,
    });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: 'no such route; see /llms.txt' }));

  // --- site & metadata -----------------------------------------------------
  const base = config.publicBaseUrl;
  const site = { maxWatches: config.maxWatchesPerClient, watchTtlDays: config.watchTtlDays };
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(homepage(base, site)));
  app.get('/docs', async (_req, reply) => reply.type('text/html; charset=utf-8').send(docsPage(base, site)));
  const fonts = new Map(FONT_FILES.map((f) => [f, readFileSync(new URL(`../public/fonts/${f}`, import.meta.url))]));
  app.get<{ Params: { file: string } }>('/fonts/:file', { config: { limit: false } }, async (req, reply) => {
    const font = fonts.get(req.params.file);
    if (!font) throw new AppError(404, 'NOT_FOUND', 'no such font');
    return reply.type('font/woff2').header('cache-control', 'public, max-age=2592000').send(font);
  });
  // The list changes only when boards are checked or added, so one rendering serves every visitor for a few minutes.
  let companiesHtml: { at: number; html: string } | null = null;
  app.get('/companies', async (_req, reply) => {
    if (!companiesHtml || Date.now() - companiesHtml.at > 5 * 60_000) companiesHtml = { at: Date.now(), html: companiesPage(await loadCompanies(ctx)) };
    return reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300').send(companiesHtml.html);
  });
  app.get('/terms', async (_req, reply) => reply.type('text/html; charset=utf-8').send(termsPage()));
  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(privacyPage(base, site)));
  app.get('/llms.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').send(llmsTxt(base, site)));
  app.get('/.well-known/watchtower.json', async () => wellKnown(base, site));
  app.get('/.well-known/mcp.json', async () => serverCard(base));
  // Public ownership proof for the Watchtower OpenAI plugin submission.
  app.get('/.well-known/openai-apps-challenge', { config: { limit: false } }, async (_req, reply) =>
    reply.type('text/plain; charset=utf-8').send('hVR1ZU10lOhz8t3zqCFwK6zeP93zUV5yhy5PdXzbWsU'),
  );
  app.get('/.well-known/mcp-server-card', async () => serverCard(base));
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').send(robotsTxt(base)));
  if (config.mcpRegistryAuth) {
    const record = config.mcpRegistryAuth;
    app.get('/.well-known/mcp-registry-auth', async (_req, reply) => reply.type('text/plain; charset=utf-8').send(record));
  }
  app.get('/health', { config: { limit: false } }, async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });
  app.get('/metrics', { config: { limit: false } }, async (req, reply) => {
    if (config.metricsToken && req.headers.authorization !== `Bearer ${config.metricsToken}`) {
      throw new AppError(401, 'UNAUTHORIZED', 'metrics require the METRICS_TOKEN bearer token');
    }
    return reply.type('text/plain; version=0.0.4').send(await renderMetrics(db));
  });

  // --- usage stats (operator only) -------------------------------------------
  if (config.statsToken) {
    const expected = Buffer.from(config.statsToken);
    const authorized = (header: string | undefined) => {
      const m = /^(Basic|Bearer)\s+(\S+)$/i.exec(header ?? '');
      if (!m) return false;
      const given = Buffer.from(m[1]!.toLowerCase() === 'basic' ? Buffer.from(m[2]!, 'base64').toString().replace(/^[^:]*:/, '') : m[2]!);
      return given.length === expected.length && timingSafeEqual(given, expected);
    };
    app.get('/stats', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!authorized(req.headers.authorization)) {
        return reply.code(401).header('www-authenticate', 'Basic realm="Watchtower stats", charset="UTF-8"').type('text/plain').send('Log in with any username and the STATS_TOKEN as the password.');
      }
      return reply.type('text/html; charset=utf-8').send(statsPage(await loadStats(ctx)));
    });
  }

  // --- REST ------------------------------------------------------------------
  // search_jobs scans every monitored board's open jobs and needs no token, so it has its own per-address budget.
  const searchLimit = { name: 'search', max: config.searchPerMinute, windowSeconds: 60 };
  await registerApiRoutes(app, ctx, { clientCreationPerHour: config.clientCreationPerHour, searchLimit });

  // --- OAuth for MCP connections ---------------------------------------------
  await registerOAuthRoutes(app, ctx, { clientCreationPerHour: config.clientCreationPerHour });

  // --- MCP (Streamable HTTP, stateless) ---------------------------------------
  // Identity comes from the connection's bearer token (OAuth or a configured header), or from the client_token argument
  // older conversations still pass. Without either, search_jobs and list_companies work; watch_jobs provisions an
  // anonymous client while MCP_ANONYMOUS_PROVISIONING is on (drawing on the same per-address budget as POST /v1/clients),
  // and the other watch tools answer with an OAuth challenge.
  // A token that is sent but unknown, or a connection to /mcp?auth=required without one, gets an HTTP 401 challenge,
  // which is what makes spec clients (Claude Code, Cursor, ...) run the OAuth flow.
  const allowProvision = async (ip: string) =>
    (await hit(db, clientBucket(ip), { name: 'client_creation', max: config.clientCreationPerHour, windowSeconds: 3600 })).allowed;
  const challenge = (reply: import('fastify').FastifyReply, description: string) =>
    reply
      .code(401)
      .header('www-authenticate', authChallenge(base, description))
      .send({ jsonrpc: '2.0', error: { code: -32001, message: description }, id: null });

  app.post('/mcp', async (req, reply) => {
    const origin = clientOrigin(req.query, req.headers['user-agent']);
    const headerToken = bearerToken(req.headers.authorization);
    if (headerToken) {
      try {
        await authenticate(ctx, headerToken);
      } catch {
        return challenge(reply, 'The Watchtower token is unknown or revoked; authorize again.');
      }
    } else if ((req.query as { auth?: unknown } | undefined)?.auth === 'required') {
      return challenge(reply, 'Authorize Watchtower to use watches.');
    }
    const body = req.body as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } } | undefined;
    if (body?.method === 'initialize') {
      const info = body.params?.clientInfo;
      const client = typeof info?.name === 'string' ? info.name.toLowerCase().replace(/[^a-z0-9._ -]/g, '').slice(0, 40) || 'unknown' : 'unknown';
      metrics.mcpInitialize.inc({ client, ref: origin.source ?? 'none' });
      await countDaily(ctx, 'mcp_connect', client);
      req.log.info({ mcp_client: client, mcp_client_version: typeof info?.version === 'string' ? info.version.slice(0, 40) : undefined, ref: origin.source }, 'mcp initialize');
    }
    const server = buildMcpServer(ctx, {
      headerToken,
      allowProvision: () => allowProvision(req.ip),
      limitSearch: () => enforce(db, clientBucket(req.ip), searchLimit),
      origin,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const mcpMethodNotAllowed = async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless; use POST.' }, id: null });
  app.get('/mcp', mcpMethodNotAllowed);
  app.delete('/mcp', mcpMethodNotAllowed);

  return { app, ctx };
}
