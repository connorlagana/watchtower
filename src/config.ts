/**
 * Runtime configuration, read once from the environment.
 * Every knob has a production-safe default; see .env.example.
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return Math.trunc(n);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  publicBaseUrl: string;
  logLevel: string;
  migrateOnStart: boolean;
  runScheduler: boolean;

  maxWatchesPerClient: number;
  /** Floor for how often a single resource may be fetched. */
  minCheckIntervalSeconds: number;
  defaultCheckIntervalSeconds: number;
  schedulerTickMs: number;
  schedulerConcurrency: number;

  fetchTimeoutMs: number;
  maxBodyBytes: number;
  /** Body cap for job-board platform APIs, whose listings carry every posting's text. */
  maxApiBodyBytes: number;
  maxRedirects: number;
  /** DANGEROUS: lets the fetcher reach private/loopback addresses. Tests and the local demo only. */
  allowPrivateNetworks: boolean;
  /** Ports the fetcher may connect to. Empty = any port (only sensible with allowPrivateNetworks). */
  allowedPorts: number[];
  userAgent: string;

  /** Space between two fetches to the same host (cluster-wide). */
  hostMinSpacingMs: number;

  /** Watches nobody has read for this long are deleted and stop costing fetches. */
  watchTtlDays: number;
  maxWatchesPerClientPerHost: number;
  maxResourcesPerHost: number;
  maxActiveResources: number;
  changeRetentionDays: number;
  snapshotRetentionDays: number;

  trustProxy: boolean;
  rateLimitPerMinute: number;
  clientCreationPerHour: number;

  /** Monitor the built-in directory of boards so search watches (no URL) have something to match. */
  indexEnabled: boolean;
  indexCheckIntervalSeconds: number;
  /** How many boards watched by URL may be kept in the directory after their watch ends. 0 keeps none. */
  indexMaxPromoted: number;
  /** Optional file of extra board URLs (one per line, # comments) to add to the directory. */
  indexBoardsFile: string | null;

  webhookTimeoutMs: number;
  /** If set, GET /metrics requires "Authorization: Bearer <token>". */
  metricsToken: string | null;
  /** Password for /stats (HTTP Basic, any username, or a Bearer token). Falls back to metricsToken; unset hides the page. */
  statsToken: string | null;
  /** Served at /.well-known/mcp-registry-auth to prove domain ownership to the MCP Registry ("v=MCPv1; k=ed25519; p=..."). */
  mcpRegistryAuth: string | null;
}

export function loadConfig(): Config {
  const publicBaseUrl = str('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');
  const allowPrivateNetworks = bool('ALLOW_PRIVATE_NETWORKS', false);
  const portsRaw = str('ALLOWED_PORTS', allowPrivateNetworks ? '' : '80,443');
  return {
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    databaseUrl: str('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/watchtower'),
    publicBaseUrl,
    logLevel: str('LOG_LEVEL', 'info'),
    migrateOnStart: bool('MIGRATE_ON_START', true),
    runScheduler: bool('RUN_SCHEDULER', true),

    maxWatchesPerClient: int('MAX_WATCHES_PER_CLIENT', 50),
    minCheckIntervalSeconds: int('MIN_CHECK_INTERVAL_SECONDS', 300),
    defaultCheckIntervalSeconds: int('DEFAULT_CHECK_INTERVAL_SECONDS', 3600),
    schedulerTickMs: int('SCHEDULER_TICK_MS', 5000),
    schedulerConcurrency: int('SCHEDULER_CONCURRENCY', 4),

    fetchTimeoutMs: int('FETCH_TIMEOUT_MS', 15_000),
    maxBodyBytes: int('MAX_BODY_BYTES', 3 * 1024 * 1024),
    maxApiBodyBytes: int('MAX_API_BODY_BYTES', 64 * 1024 * 1024),
    maxRedirects: int('MAX_REDIRECTS', 5),
    allowPrivateNetworks,
    allowedPorts: portsRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map(Number),
    userAgent: str('USER_AGENT', `WatchtowerBot/0.1 (+${publicBaseUrl}; tech job monitoring for AI agents)`),

    hostMinSpacingMs: int('HOST_MIN_SPACING_MS', 2000),

    watchTtlDays: int('WATCH_TTL_DAYS', 30),
    maxWatchesPerClientPerHost: int('MAX_WATCHES_PER_CLIENT_PER_HOST', 5),
    maxResourcesPerHost: int('MAX_RESOURCES_PER_HOST', 100),
    maxActiveResources: int('MAX_ACTIVE_RESOURCES', 50_000),
    changeRetentionDays: int('CHANGE_RETENTION_DAYS', 30),
    snapshotRetentionDays: int('SNAPSHOT_RETENTION_DAYS', 7),

    trustProxy: bool('TRUST_PROXY', false),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 120),
    clientCreationPerHour: int('CLIENT_CREATION_PER_HOUR', 10),

    indexEnabled: bool('INDEX_ENABLED', true),
    indexCheckIntervalSeconds: int('INDEX_CHECK_INTERVAL_SECONDS', 4 * 3600),
    indexMaxPromoted: int('INDEX_MAX_PROMOTED', 5000),
    indexBoardsFile: process.env.INDEX_BOARDS_FILE || null,

    webhookTimeoutMs: int('WEBHOOK_TIMEOUT_MS', 10_000),
    metricsToken: process.env.METRICS_TOKEN || null,
    statsToken: process.env.STATS_TOKEN || process.env.METRICS_TOKEN || null,
    mcpRegistryAuth: process.env.MCP_REGISTRY_AUTH || null,
  };
}
