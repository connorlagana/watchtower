/**
 * Optional push delivery. Changes are written to an outbox (webhook_deliveries)
 * in the same way get_changes would filter them, then delivered with retries.
 *
 * Each request carries
 *   x-watchtower-timestamp: <unix seconds>
 *   x-watchtower-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" keyed by the watch's webhook secret>
 */
import { createHmac, randomBytes } from 'node:crypto';
import { safePost } from '../fetch/safeFetch.js';
import { WATCH_SEES_CHANGE, type Ctx } from './context.js';
import { metrics } from './metrics.js';

const MAX_ATTEMPTS = 8;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Queue deliveries for changes (minId, maxId] of a resource to every webhook watch that should see them. */
export async function enqueueWebhooks(ctx: Ctx, resourceId: string, minId: number, maxId: number): Promise<number> {
  const { rowCount } = await ctx.db.query(
    `INSERT INTO webhook_deliveries (watch_id, payload)
     SELECT w.id, jsonb_build_object(
              'watch_id', w.id, 'watch_label', w.label, 'watch_kind', w.kind, 'url', w.source_url,
              'changes', jsonb_agg(jsonb_build_object(
                 'id', c.id, 'type', c.type, 'summary', c.summary, 'detected_at', c.detected_at, 'data', c.data) ORDER BY c.id))
       FROM watches w
       JOIN changes c ON c.resource_id = w.resource_id
      WHERE w.resource_id = $1 AND w.deleted_at IS NULL AND w.webhook_url IS NOT NULL
        AND c.id > GREATEST($2::bigint, w.baseline) AND c.id <= $3
        AND ${WATCH_SEES_CHANGE}
      GROUP BY w.id`,
    [resourceId, minId, maxId],
  );
  return rowCount ?? 0;
}

interface DeliveryRow {
  id: number;
  watch_id: string;
  payload: unknown;
  attempts: number;
  webhook_url: string | null;
  webhook_secret: string | null;
  deleted_at: Date | null;
}

/** Send due deliveries. Claims rows with SKIP LOCKED and a short lease so replicas don't double-send. */
export async function deliverDueWebhooks(ctx: Ctx, limit = 10): Promise<number> {
  const { rows } = await ctx.db.query<DeliveryRow>(
    `WITH due AS (
       SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT $1
        FOR UPDATE SKIP LOCKED)
     UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '2 minutes'
       FROM due, watches w
      WHERE d.id = due.id AND w.id = d.watch_id
     RETURNING d.id, d.watch_id, d.payload, d.attempts, w.webhook_url, w.webhook_secret, w.deleted_at`,
    [limit],
  );
  await Promise.all(rows.map((row) => deliverOne(ctx, row)));
  return rows.length;
}

async function deliverOne(ctx: Ctx, row: DeliveryRow): Promise<void> {
  if (!row.webhook_url || !row.webhook_secret || row.deleted_at) {
    await ctx.db.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'watch deleted or webhook removed' WHERE id = $1`, [row.id]);
    return;
  }
  const body = JSON.stringify({ delivery_id: row.id, ...(row.payload as object) });
  const ts = Math.floor(Date.now() / 1000);
  let error: string | null = null;
  try {
    const res = await safePost(row.webhook_url, body, {
      policy: { allowPrivateNetworks: ctx.config.allowPrivateNetworks, allowedPorts: ctx.config.allowedPorts },
      timeoutMs: ctx.config.webhookTimeoutMs,
      userAgent: ctx.config.userAgent,
      headers: { 'x-watchtower-timestamp': String(ts), 'x-watchtower-signature': sign(row.webhook_secret, ts, body), 'x-watchtower-delivery': String(row.id) },
    });
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
  }

  if (!error) {
    metrics.webhooks.inc({ result: 'delivered' });
    await ctx.db.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, delivered_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
    // A consumer that only uses webhooks is still an active consumer.
    await ctx.db.query('UPDATE watches SET last_accessed_at = now() WHERE id = $1', [row.watch_id]);
    return;
  }
  const attempts = row.attempts + 1;
  const final = attempts >= MAX_ATTEMPTS;
  metrics.webhooks.inc({ result: final ? 'failed' : 'retry' });
  await ctx.db.query(
    `UPDATE webhook_deliveries SET attempts = $2, last_error = $3, status = $4,
       next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
    [row.id, attempts, error.slice(0, 500), final ? 'failed' : 'pending', Math.min(30 * 2 ** attempts, 6 * 3600)],
  );
}
