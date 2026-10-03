import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApiRoutes } from './api/routes.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { buildMcpServer } from './mcp/server.js';
import { bearerToken, clientOrigin } from './services/clients.js';
import { AppError, type Ctx } from './services/context.js';
import { metrics, renderMetrics } from './services/metrics.js';
import { clientBucket, hit, registerRateLimits } from './services/rateLimit.js';
import { homepage, llmsTxt, privacyPage, robotsTxt, serverCard, wellKnown } from './web/site.js';

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
  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(privacyPage(base, site)));
  app.get('/llms.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').send(llmsTxt(base, site)));
  app.get('/.well-known/watchtower.json', async () => wellKnown(base, site));
  app.get('/.well-known/mcp.json', async () => serverCard(base));
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

  // --- REST ------------------------------------------------------------------
  await registerApiRoutes(app, ctx, { clientCreationPerHour: config.clientCreationPerHour });

  // --- MCP (Streamable HTTP, stateless) ---------------------------------------
  // Tokenless watch_* calls auto-create a client; they draw from the same shared
  // per-address budget as POST /v1/clients so MCP isn't a way around it.
  const allowProvision = async (ip: string) =>
    (await hit(db, clientBucket(ip), { name: 'client_creation', max: config.clientCreationPerHour, windowSeconds: 3600 })).allowed;

  app.post('/mcp', async (req, reply) => {
    const origin = clientOrigin(req.query, req.headers['user-agent']);
    const body = req.body as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } } | undefined;
    if (body?.method === 'initialize') {
      const info = body.params?.clientInfo;
      const client = typeof info?.name === 'string' ? info.name.toLowerCase().replace(/[^a-z0-9._ -]/g, '').slice(0, 40) || 'unknown' : 'unknown';
      metrics.mcpInitialize.inc({ client, ref: origin.source ?? 'none' });
      req.log.info({ mcp_client: client, mcp_client_version: typeof info?.version === 'string' ? info.version.slice(0, 40) : undefined, ref: origin.source }, 'mcp initialize');
    }
    const server = buildMcpServer(ctx, { headerToken: bearerToken(req.headers.authorization), allowProvision: () => allowProvision(req.ip), origin });
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
