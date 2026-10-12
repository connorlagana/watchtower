import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from './context.js';
import { AppError } from './context.js';

export interface Client {
  id: string;
  created_at: Date;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newTokenValue = () => `wt_${randomBytes(24).toString('base64url')}`;

/** Where a new client came from: the ?ref= tag of the URL it was created through, and its User-Agent. */
export interface ClientOrigin {
  source?: string | null;
  userAgent?: string | null;
}

/** Reads the origin of a request; an unusable ref tag is dropped rather than rejected. */
export function clientOrigin(query: unknown, userAgent: string | undefined): ClientOrigin {
  const ref = (query as { ref?: unknown } | undefined)?.ref;
  const source = typeof ref === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(ref) ? ref.toLowerCase() : null;
  return { source, userAgent: userAgent ? userAgent.slice(0, 200) : null };
}

/**
 * Anonymous client: the bearer token is shown once and only its hash is stored. A client made for an OAuth consent
 * passes tokenShown false: its own token is thrown away and it is reached only through connection tokens.
 */
export async function createClient(ctx: Ctx, origin: ClientOrigin = {}, tokenShown = true): Promise<{ client: Client; token: string }> {
  const token = newTokenValue();
  const { rows } = await ctx.db.query<Client>(
    'INSERT INTO clients (token_hash, source, user_agent, token_shown) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [hashToken(token), origin.source ?? null, origin.userAgent ?? null, tokenShown],
  );
  return { client: rows[0]!, token };
}

/** Credits an OAuth-created client to the ?ref= tag of the MCP URL its app connects through, which the consent cannot see. */
export async function attributeSource(ctx: Ctx, clientId: string, source: string): Promise<void> {
  await ctx.db.query("UPDATE clients SET source = $2 WHERE id = $1 AND source = 'oauth'", [clientId, source]);
}

export async function authenticate(ctx: Ctx, token: string | undefined | null): Promise<Client> {
  if (!token || !/^wt_[A-Za-z0-9_-]{20,64}$/.test(token)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid token. Create one with POST /v1/clients and send it as "Authorization: Bearer <token>".');
  }
  const { rows } = await ctx.db.query<Client>(
    `SELECT id, created_at FROM clients WHERE token_hash = $1
     UNION ALL
     SELECT c.id, c.created_at FROM client_tokens t JOIN clients c ON c.id = t.client_id WHERE t.token_hash = $1
     LIMIT 1`,
    [hashToken(token)],
  );
  const client = rows[0];
  if (!client) throw new AppError(401, 'UNAUTHORIZED', 'Unknown token.');
  // Cheap activity tracking; at most one write per client per hour.
  await ctx.db.query("UPDATE clients SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 hour'", [client.id]);
  return client;
}

/**
 * Points an OAuth connection at an older client whose token the caller also presented, so a user who connects the app
 * keeps the watches their conversations were using. Only a connection whose own client has no active watches moves.
 * A client the consent created that is left with no way in is deleted, and its usage history is merged into the
 * adopting client, so one person is not counted as two users. Returns whether it moved.
 */
export async function adoptConnection(ctx: Ctx, connectionToken: string, clientId: string): Promise<boolean> {
  const conn = await ctx.db.connect();
  try {
    await conn.query('BEGIN');
    const { rows } = await conn.query<{ old: string }>(
      `UPDATE client_tokens t SET client_id = $2 FROM client_tokens o
        WHERE t.token_hash = $1 AND o.token_hash = $1 AND t.client_id <> $2
          AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.client_id = t.client_id AND w.deleted_at IS NULL)
        RETURNING o.client_id AS old`,
      [hashToken(connectionToken), clientId],
    );
    const old = rows[0]?.old;
    if (old) {
      const { rowCount } = await conn.query(
        `DELETE FROM clients c WHERE c.id = $1 AND NOT c.token_shown
            AND NOT EXISTS (SELECT 1 FROM client_tokens t WHERE t.client_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.client_id = c.id)`,
        [old],
      );
      if (rowCount) {
        await conn.query(
          `WITH moved AS (DELETE FROM usage_daily WHERE client_id = $1 RETURNING day, tool, via, calls)
           INSERT INTO usage_daily (day, client_id, tool, via, calls) SELECT day, $2, tool, via, calls FROM moved
           ON CONFLICT (day, client_id, tool, via) DO UPDATE SET calls = usage_daily.calls + excluded.calls`,
          [old, clientId],
        );
      }
    }
    await conn.query('COMMIT');
    return old !== undefined;
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** Another token for an existing client, issued by an OAuth grant. Shown once; only its hash is stored. */
export async function issueToken(ctx: Ctx, clientId: string, oauthClientId: string): Promise<string> {
  const token = newTokenValue();
  await ctx.db.query('INSERT INTO client_tokens (token_hash, client_id, oauth_client_id) VALUES ($1, $2, $3)', [hashToken(token), clientId, oauthClientId]);
  return token;
}

export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}
