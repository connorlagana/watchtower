/**
 * Cluster-wide per-host politeness. A host lease means "a fetch to this host
 * is in flight"; releasing it pushes the lease forward by the minimum spacing,
 * so consecutive fetches to one host are serialized and spaced out no matter
 * how many resources, clients or replicas are involved.
 */
import type { Db } from '../db.js';

export async function tryAcquireHost(db: Db, host: string, leaseMs: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO host_leases (host, leased_until) VALUES ($1, now() + make_interval(secs => $2 / 1000.0))
     ON CONFLICT (host) DO UPDATE SET leased_until = EXCLUDED.leased_until
       WHERE host_leases.leased_until <= now()`,
    [host, leaseMs],
  );
  return rowCount === 1;
}

export async function releaseHost(db: Db, host: string, spacingMs: number): Promise<void> {
  await db.query(`UPDATE host_leases SET leased_until = now() + make_interval(secs => $2 / 1000.0) WHERE host = $1`, [host, spacingMs]);
}

/** Poll for a lease for up to `maxWaitMs` (used by synchronous paths like watch creation). */
export async function acquireHostWaiting(db: Db, host: string, leaseMs: number, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    if (await tryAcquireHost(db, host, leaseMs)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}
