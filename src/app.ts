import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApiRoutes } from './api/routes.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { buildMcpServer } from './mcp/server.js';
import { bearerToken } from './services/clients.js';
import { AppError, type Ctx } from './services/context.js';
import { homepage, llmsTxt, wellKnown } from './web/site.js';

export async function buildApp(config: Config, db: Db, opts: { logger?: boolean } = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy,
  });
  const ctx: Ctx = { db, config, log: app.log };

  await app.register(rateLimit, { max: config.rateLimitPerMinute, timeWindow: '1 minute' });

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
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(homepage(base, config.maxWatchesPerClient)));
  app.get('/llms.txt', async (_req, reply) => reply.type('text/plain; charset=utf-8').send(llmsTxt(base, config.maxWatchesPerClient)));
  app.get('/.well-known/watchtower.json', async () => wellKnown(base, config.maxWatchesPerClient));
  app.get('/health', { config: { rateLimit: false } }, async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // --- REST ------------------------------------------------------------------
  await registerApiRoutes(app, ctx, { clientCreationPerHour: config.clientCreationPerHour });

  // --- MCP (Streamable HTTP, stateless) ---------------------------------------
  // Tokenless watch_* calls auto-create a client; hold them to the same per-IP
  // budget as POST /v1/clients so MCP isn't a way around it.
  const provisioned = new Map<string, { count: number; resetAt: number }>();
  const allowProvision = (ip: string) => {
    const now = Date.now();
    let entry = provisioned.get(ip);
    if (!entry || entry.resetAt < now) {
      if (provisioned.size > 10_000) provisioned.clear();
      entry = { count: 0, resetAt: now + 3_600_000 };
      provisioned.set(ip, entry);
    }
    return ++entry.count <= config.clientCreationPerHour;
  };

  app.post('/mcp', async (req, reply) => {
    const server = buildMcpServer(ctx, { headerToken: bearerToken(req.headers.authorization), allowProvision: () => allowProvision(req.ip) });
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
