/**
 * Background work: checks due resources, delivers webhooks, and runs periodic
 * maintenance (watch expiry, retention).
 *
 * Claiming picks at most one due resource per host and skips hosts whose
 * politeness lease is held; the lease itself (taken in the checker) is what
 * guarantees one in-flight fetch per host across all replicas.
 */
import { PROMOTED_MAX_FAILURES } from './boardIndex.js';
import { checkResource } from './checker.js';
import { RESOURCE_IS_MONITORED, type Ctx } from './context.js';
import { deliverDueWebhooks } from './webhooks.js';

const CLAIM_LEASE_SECONDS = 600;
const MAINTENANCE_EVERY_MS = 10 * 60 * 1000;

export async function claimDue(ctx: Ctx, limit: number): Promise<string[]> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `UPDATE resources SET next_check_at = now() + make_interval(secs => $2)
      WHERE next_check_at <= now()
        AND id IN (
          SELECT id FROM (
            SELECT DISTINCT ON (r.host) r.id, r.next_check_at
              FROM resources r
             WHERE r.next_check_at <= now()
               AND ${RESOURCE_IS_MONITORED}
               AND NOT EXISTS (SELECT 1 FROM host_leases h WHERE h.host = r.host AND h.leased_until > now())
             ORDER BY r.host, r.next_check_at
          ) per_host
          ORDER BY next_check_at
          LIMIT $1)
      RETURNING id`,
    [limit, CLAIM_LEASE_SECONDS],
  );
  return rows.map((r) => r.id);
}

export interface MaintenanceReport {
  expiredWatches: number;
  deletedChanges: number;
  deletedSnapshots: number;
  deletedResources: number;
  deletedClients: number;
}

/** Expire unread watches and enforce retention. Safe to call from every replica (advisory-locked). */
export async function runMaintenance(ctx: Ctx): Promise<MaintenanceReport | null> {
  const client = await ctx.db.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(727275) AS locked');
    if (!rows[0]?.locked) return null;
    try {
      const c = ctx.config;
      const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rowCount ?? 0;
      const report: MaintenanceReport = {
        expiredWatches: await q(
          `UPDATE watches SET deleted_at = now(), delete_reason = 'expired'
            WHERE deleted_at IS NULL AND last_accessed_at < now() - make_interval(days => $1)`,
          [c.watchTtlDays],
        ),
        deletedChanges: await q('DELETE FROM changes WHERE detected_at < now() - make_interval(days => $1)', [c.changeRetentionDays]),
        deletedSnapshots: await q(
          `DELETE FROM snapshots s WHERE s.fetched_at < now() - make_interval(days => $1)
              AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.current_snapshot_id = s.id)`,
          [c.snapshotRetentionDays],
        ),
        deletedResources: 0,
        deletedClients: 0,
      };
      await q("DELETE FROM watches WHERE deleted_at < now() - interval '30 days'");
      // A board a client added to the directory leaves it once it has stopped answering.
      await q("UPDATE resources SET indexed = false, index_origin = NULL WHERE indexed AND index_origin = 'watched' AND consecutive_failures >= $1", [PROMOTED_MAX_FAILURES]);
      report.deletedResources = await q(
        `DELETE FROM resources r WHERE r.created_at < now() - interval '1 day' AND NOT r.indexed
            AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.resource_id = r.id)`,
      );
      report.deletedClients = await q(
        `DELETE FROM clients c WHERE c.last_seen_at < now() - interval '90 days'
            AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.client_id = c.id AND w.deleted_at IS NULL)`,
      );
      await q("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
      await q('DELETE FROM oauth_codes WHERE expires_at < now()');
      await q("DELETE FROM usage_daily WHERE day < now() - interval '400 days'");
      await q("DELETE FROM counts_daily WHERE day < now() - interval '400 days'");
      await q("DELETE FROM host_leases WHERE leased_until < now() - interval '1 hour'");
      await q("DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < now() - interval '7 days'");
      if (Object.values(report).some((n) => n > 0)) ctx.log.info(report, 'maintenance');
      return report;
    } finally {
      await client.query('SELECT pg_advisory_unlock(727275)');
    }
  } finally {
    client.release();
  }
}

export function startScheduler(ctx: Ctx): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastMaintenance = 0;
  const running = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const t = p.finally(() => running.delete(t));
    running.add(t);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const free = ctx.config.schedulerConcurrency - running.size;
      if (free > 0) {
        for (const id of await claimDue(ctx, free)) {
          track(checkResource(ctx, id).catch((err) => ctx.log.error({ err, resource: id }, 'scheduled check crashed')));
        }
      }
      track(deliverDueWebhooks(ctx).catch((err) => ctx.log.error({ err }, 'webhook delivery failed')));
      if (Date.now() - lastMaintenance > MAINTENANCE_EVERY_MS) {
        lastMaintenance = Date.now();
        track(runMaintenance(ctx).catch((err) => ctx.log.error({ err }, 'maintenance failed')));
      }
    } catch (err) {
      ctx.log.error({ err }, 'scheduler tick failed');
    }
    if (!stopped) timer = setTimeout(tick, ctx.config.schedulerTickMs);
  };
  timer = setTimeout(tick, 250);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.allSettled([...running]);
    },
  };
}
