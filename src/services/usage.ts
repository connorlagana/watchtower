/**
 * Usage history behind /stats: who used which tool on which day, page views and MCP connections.
 * Recording never fails the request it belongs to.
 */
import type { Ctx } from './context.js';

const TODAY = "(now() AT TIME ZONE 'UTC')::date";

export type Via = 'mcp' | 'rest';

/** One call of a tool by an authenticated client. */
export async function recordUse(ctx: Ctx, clientId: string, tool: string, via: Via): Promise<void> {
  try {
    await ctx.db.query(
      `INSERT INTO usage_daily (day, client_id, tool, via, calls) VALUES (${TODAY}, $1, $2, $3, 1)
       ON CONFLICT (day, client_id, tool, via) DO UPDATE SET calls = usage_daily.calls + 1`,
      [clientId, tool, via],
    );
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'usage not recorded');
  }
}

/** Adds one to an anonymous daily counter. */
export async function countDaily(ctx: Ctx, metric: string, dim: string): Promise<void> {
  try {
    await ctx.db.query(
      `INSERT INTO counts_daily (day, metric, dim, n) VALUES (${TODAY}, $1, $2, 1)
       ON CONFLICT (day, metric, dim) DO UPDATE SET n = counts_daily.n + 1`,
      [metric, dim.slice(0, 120)],
    );
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'count not recorded');
  }
}

/** AI assistants and their crawlers, by the User-Agent tokens they publish. */
const AI_AGENTS = /gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|claude-searchbot|anthropic|perplexity|google-extended|ccbot|bytespider|meta-externalagent|mistralai|cohere-ai|youbot|duckassistbot/i;
const BOTS = /bot\b|bot\/|crawl|spider|slurp|preview|headless|monitor|uptime|curl|wget|python|node-fetch|undici|axios|go-http|okhttp|java\//i;

/** browser = a person, ai = an AI assistant or its crawler, other = every other bot or script. */
export function agentClass(userAgent: string | undefined): 'browser' | 'ai' | 'other' {
  if (!userAgent) return 'other';
  if (AI_AGENTS.test(userAgent)) return 'ai';
  if (BOTS.test(userAgent) || !/mozilla\//i.test(userAgent)) return 'other';
  return 'browser';
}

export interface Stats {
  generatedAt: Date;
  kpis: {
    activeToday: number;
    active7d: number;
    active30d: number;
    clientsTotal: number;
    clientsWithWatches: number;
    liveWatches: number;
    newToday: number;
    callsToday: number;
    peopleViewsToday: number;
  };
  /** Last 30 UTC days, oldest first. */
  days: string[];
  dailyActive: number[];
  dailyNew: number[];
  dailyCalls: number[];
  dailyViews: { browser: number[]; ai: number[]; other: number[] };
  tools: { tool: string; via: string; today: number; d7: number; d30: number; clients30: number }[];
  mcpClients: { client: string; d7: number; d30: number }[];
  sources: { source: string; new30: number; active7: number }[];
  pages: { path: string; browser: number; ai: number; other: number }[];
  retention: { cohort: number; returned: number };
}

export async function loadStats(ctx: Ctx): Promise<Stats> {
  const q = async <T>(sql: string) => (await ctx.db.query(sql)).rows as T[];
  const days = `(SELECT generate_series(${TODAY} - 29, ${TODAY}, interval '1 day')::date AS d) AS days`;

  const [k] = await q<Stats['kpis']>(`SELECT
      (SELECT count(DISTINCT client_id) FROM usage_daily WHERE day = ${TODAY})::int AS "activeToday",
      (SELECT count(DISTINCT client_id) FROM usage_daily WHERE day > ${TODAY} - 7)::int AS "active7d",
      (SELECT count(DISTINCT client_id) FROM usage_daily WHERE day > ${TODAY} - 30)::int AS "active30d",
      (SELECT count(*) FROM clients)::int AS "clientsTotal",
      (SELECT count(DISTINCT client_id) FROM watches WHERE deleted_at IS NULL)::int AS "clientsWithWatches",
      (SELECT count(*) FROM watches WHERE deleted_at IS NULL)::int AS "liveWatches",
      (SELECT count(*) FROM clients WHERE (created_at AT TIME ZONE 'UTC')::date = ${TODAY})::int AS "newToday",
      (SELECT coalesce(sum(calls), 0) FROM usage_daily WHERE day = ${TODAY})::int AS "callsToday",
      (SELECT coalesce(sum(n), 0) FROM counts_daily WHERE day = ${TODAY} AND metric = 'page_view' AND dim LIKE '%|browser')::int AS "peopleViewsToday"`);

  const series = await q<{ day: string; active: number; new: number; calls: number; browser: number; ai: number; other: number }>(`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
      (SELECT count(DISTINCT client_id) FROM usage_daily u WHERE u.day = d)::int AS active,
      (SELECT count(*) FROM clients c WHERE (c.created_at AT TIME ZONE 'UTC')::date = d)::int AS new,
      (SELECT coalesce(sum(calls), 0) FROM usage_daily u WHERE u.day = d)::int AS calls,
      (SELECT coalesce(sum(n), 0) FROM counts_daily v WHERE v.day = d AND v.metric = 'page_view' AND v.dim LIKE '%|browser')::int AS browser,
      (SELECT coalesce(sum(n), 0) FROM counts_daily v WHERE v.day = d AND v.metric = 'page_view' AND v.dim LIKE '%|ai')::int AS ai,
      (SELECT coalesce(sum(n), 0) FROM counts_daily v WHERE v.day = d AND v.metric = 'page_view' AND v.dim LIKE '%|other')::int AS other
    FROM ${days} ORDER BY d`);

  const tools = await q<Stats['tools'][number]>(`
    SELECT tool, via,
      coalesce(sum(calls) FILTER (WHERE day = ${TODAY}), 0)::int AS today,
      coalesce(sum(calls) FILTER (WHERE day > ${TODAY} - 7), 0)::int AS d7,
      sum(calls)::int AS d30,
      count(DISTINCT client_id)::int AS clients30
    FROM usage_daily WHERE day > ${TODAY} - 30 GROUP BY tool, via ORDER BY d30 DESC, tool`);

  const mcpClients = await q<Stats['mcpClients'][number]>(`
    SELECT dim AS client, coalesce(sum(n) FILTER (WHERE day > ${TODAY} - 7), 0)::int AS d7, sum(n)::int AS d30
    FROM counts_daily WHERE metric = 'mcp_connect' AND day > ${TODAY} - 30 GROUP BY dim ORDER BY d30 DESC LIMIT 20`);

  const sources = await q<Stats['sources'][number]>(`
    WITH s AS (SELECT id, coalesce(source, '(none)') AS source, created_at FROM clients)
    SELECT source,
      count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM usage_daily u WHERE u.client_id = s.id AND u.day > ${TODAY} - 7))::int AS active7
    FROM s GROUP BY source HAVING count(*) FILTER (WHERE created_at > now() - interval '30 days') > 0
       OR count(*) FILTER (WHERE EXISTS (SELECT 1 FROM usage_daily u WHERE u.client_id = s.id AND u.day > ${TODAY} - 7)) > 0
    ORDER BY active7 DESC, new30 DESC, source`);

  const pages = await q<Stats['pages'][number]>(`
    SELECT split_part(dim, '|', 1) AS path,
      coalesce(sum(n) FILTER (WHERE dim LIKE '%|browser'), 0)::int AS browser,
      coalesce(sum(n) FILTER (WHERE dim LIKE '%|ai'), 0)::int AS ai,
      coalesce(sum(n) FILTER (WHERE dim LIKE '%|other'), 0)::int AS other
    FROM counts_daily WHERE metric = 'page_view' AND day > ${TODAY} - 7 GROUP BY 1 ORDER BY sum(n) DESC`);

  // Of the clients created 1-30 days ago that used a tool, how many came back on a later day.
  const [retention] = await q<Stats['retention']>(`
    WITH cohort AS (
      SELECT c.id, (c.created_at AT TIME ZONE 'UTC')::date AS first_day FROM clients c
      WHERE c.created_at > now() - interval '30 days' AND (c.created_at AT TIME ZONE 'UTC')::date < ${TODAY}
        AND EXISTS (SELECT 1 FROM usage_daily u WHERE u.client_id = c.id))
    SELECT count(*)::int AS cohort,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM usage_daily u WHERE u.client_id = cohort.id AND u.day > cohort.first_day))::int AS returned
    FROM cohort`);

  return {
    generatedAt: new Date(),
    kpis: k!,
    days: series.map((r) => r.day),
    dailyActive: series.map((r) => r.active),
    dailyNew: series.map((r) => r.new),
    dailyCalls: series.map((r) => r.calls),
    dailyViews: { browser: series.map((r) => r.browser), ai: series.map((r) => r.ai), other: series.map((r) => r.other) },
    tools,
    mcpClients,
    sources,
    pages,
    retention: retention!,
  };
}
