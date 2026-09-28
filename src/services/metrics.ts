/**
 * Minimal Prometheus text-format metrics. In-process counters/histograms,
 * plus gauges computed from the database at scrape time.
 */
import type { Db } from '../db.js';

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`)
    .join(',');

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  private buckets = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20];
  private counts = new Array(this.buckets.length).fill(0) as number[];
  private sum = 0;
  private count = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(seconds: number) {
    this.sum += seconds;
    this.count++;
    this.buckets.forEach((b, i) => {
      if (seconds <= b) this.counts[i]!++;
    });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{le="${b}"} ${this.counts[i]}`));
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`, `${this.name}_sum ${this.sum}`, `${this.name}_count ${this.count}`);
    return lines.join('\n');
  }
}

export const metrics = {
  checks: new Counter('watchtower_checks_total', 'Resource checks by outcome (changed|unchanged|not_modified|error) and error code.'),
  fetchSeconds: new Histogram('watchtower_fetch_duration_seconds', 'Duration of resource checks including robots.txt and confirmation fetches.'),
  changes: new Counter('watchtower_changes_emitted_total', 'Change events written, by type.'),
  suppressed: new Counter('watchtower_volatile_lines_suppressed_total', 'Changed lines suppressed as volatile noise.'),
  webhooks: new Counter('watchtower_webhook_deliveries_total', 'Webhook delivery attempts by result.'),
  hostBusy: new Counter('watchtower_host_busy_total', 'Checks deferred because another fetch to the same host was in flight.'),
};

export async function renderMetrics(db: Db): Promise<string> {
  const { rows } = await db.query<{ watches: number; resources: number; failing: number; blocked: number; webhooks_pending: number }>(
    `SELECT
       (SELECT count(*) FROM watches WHERE deleted_at IS NULL)::int AS watches,
       (SELECT count(DISTINCT resource_id) FROM watches WHERE deleted_at IS NULL)::int AS resources,
       (SELECT count(*) FROM resources WHERE consecutive_failures > 0)::int AS failing,
       (SELECT count(*) FROM resources
         WHERE last_checked_at > now() - interval '1 hour'
           AND (last_error LIKE 'BOT_CHALLENGE%' OR last_error LIKE 'ACCESS_DENIED%' OR last_error LIKE 'RATE_LIMITED%'))::int AS blocked,
       (SELECT count(*) FROM webhook_deliveries WHERE status = 'pending')::int AS webhooks_pending`,
  );
  const g = rows[0]!;
  const gauge = (name: string, help: string, v: number) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${v}`;
  return [
    ...Object.values(metrics).map((m) => m.render()),
    gauge('watchtower_active_watches', 'Active watches.', g.watches),
    gauge('watchtower_active_resources', 'Resources with at least one active watch.', g.resources),
    gauge('watchtower_failing_resources', 'Resources whose last check failed.', g.failing),
    gauge('watchtower_blocked_resources_1h', 'Resources that returned 401/403/429 or a bot challenge in the last hour.', g.blocked),
    gauge('watchtower_webhooks_pending', 'Webhook deliveries waiting to be sent or retried.', g.webhooks_pending),
  ].join('\n\n') + '\n';
}
