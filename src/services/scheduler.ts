/**
 * Polls for due resources and checks them with bounded concurrency.
 * Claiming uses FOR UPDATE SKIP LOCKED plus a lease (bumping next_check_at),
 * so several instances can run the scheduler without double-fetching.
 */
import { checkResource } from './checker.js';
import type { Ctx } from './context.js';

const LEASE_SECONDS = 600;

export async function claimDue(ctx: Ctx, limit: number): Promise<string[]> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `UPDATE resources SET next_check_at = now() + make_interval(secs => $2)
      WHERE id IN (
        SELECT r.id FROM resources r
         WHERE r.next_check_at <= now()
           AND EXISTS (SELECT 1 FROM watches w WHERE w.resource_id = r.id AND w.deleted_at IS NULL)
         ORDER BY r.next_check_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [limit, LEASE_SECONDS],
  );
  return rows.map((r) => r.id);
}

export function startScheduler(ctx: Ctx): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const running = new Set<Promise<unknown>>();

  const tick = async () => {
    if (stopped) return;
    try {
      const free = ctx.config.schedulerConcurrency - running.size;
      if (free > 0) {
        for (const id of await claimDue(ctx, free)) {
          const p = checkResource(ctx, id)
            .catch((err) => ctx.log.error({ err, resource: id }, 'scheduled check crashed'))
            .finally(() => running.delete(p));
          running.add(p);
        }
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
