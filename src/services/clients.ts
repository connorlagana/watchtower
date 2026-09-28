import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from './context.js';
import { AppError } from './context.js';

export interface Client {
  id: string;
  created_at: Date;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Anonymous client: the bearer token is shown once and only its hash is stored. */
export async function createClient(ctx: Ctx): Promise<{ client: Client; token: string }> {
  const token = `wt_${randomBytes(24).toString('base64url')}`;
  const { rows } = await ctx.db.query<Client>('INSERT INTO clients (token_hash) VALUES ($1) RETURNING id, created_at', [hashToken(token)]);
  return { client: rows[0]!, token };
}

export async function authenticate(ctx: Ctx, token: string | undefined | null): Promise<Client> {
  if (!token || !/^wt_[A-Za-z0-9_-]{20,64}$/.test(token)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid token. Create one with POST /v1/clients and send it as "Authorization: Bearer <token>".');
  }
  const { rows } = await ctx.db.query<Client>('SELECT id, created_at FROM clients WHERE token_hash = $1', [hashToken(token)]);
  const client = rows[0];
  if (!client) throw new AppError(401, 'UNAUTHORIZED', 'Unknown token.');
  // Cheap activity tracking; at most one write per client per hour.
  await ctx.db.query("UPDATE clients SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 hour'", [client.id]);
  return client;
}

export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}
