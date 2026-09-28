/**
 * Fixed-window rate limiting stored in Postgres, so limits hold across
 * replicas and restarts. One upsert per limited request.
 */
import ipaddr from 'ipaddr.js';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { AppError } from './context.js';

export interface LimitSpec {
  /** Bucket name; the same name shares a counter across routes. */
  name: string;
  max: number;
  windowSeconds: number;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Extra per-route limit on top of the global one; `false` skips all limiting. */
    limit?: LimitSpec | false;
  }
}

/**
 * The identity we rate-limit by. IPv6 clients usually control a whole /64,
 * so one address per request would make limits meaningless.
 */
export function clientBucket(ip: string): string {
  if (!ipaddr.isValid(ip)) return ip;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
    else {
      const parts = v6.parts.slice(0, 4).map((p) => p.toString(16));
      return `${parts.join(':')}::/64`;
    }
  }
  return addr.toString();
}

export async function hit(db: Db, key: string, spec: LimitSpec): Promise<{ allowed: boolean; count: number; resetAt: Date }> {
  const { rows } = await db.query<{ count: number; window_start: Date }>(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count, window_start`,
    [`${spec.name}:${key}`, spec.windowSeconds],
  );
  const row = rows[0]!;
  return { allowed: row.count <= spec.max, count: row.count, resetAt: new Date(row.window_start.getTime() + spec.windowSeconds * 1000) };
}

export async function enforce(db: Db, key: string, spec: LimitSpec): Promise<void> {
  const r = await hit(db, key, spec);
  if (!r.allowed) {
    const retry = Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000));
    throw new AppError(429, 'RATE_LIMITED', `rate limit "${spec.name}" exceeded (${spec.max} per ${spec.windowSeconds}s); retry in ${retry}s`);
  }
}

/** Global per-client limit plus any per-route `config.limit`. */
export function registerRateLimits(app: FastifyInstance, db: Db, global: LimitSpec): void {
  app.addHook('onRequest', async (req, reply) => {
    const routeLimit = req.routeOptions.config?.limit;
    if (routeLimit === false) return;
    const key = clientBucket(req.ip);
    const g = await hit(db, key, global);
    reply.header('x-ratelimit-limit', global.max);
    reply.header('x-ratelimit-remaining', Math.max(0, global.max - g.count));
    if (!g.allowed) {
      reply.header('retry-after', Math.max(1, Math.ceil((g.resetAt.getTime() - Date.now()) / 1000)));
      throw new AppError(429, 'RATE_LIMITED', `too many requests (${global.max} per ${global.windowSeconds}s)`);
    }
    if (routeLimit) await enforce(db, key, routeLimit);
  });
}
