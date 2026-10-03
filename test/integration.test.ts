/**
 * Full-stack tests against a real Postgres (TEST_DATABASE_URL) and a local
 * fixture website. Skipped when no test database is configured.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { createHmac } from 'node:crypto';
import { checkResource } from '../src/services/checker.js';
import type { Ctx } from '../src/services/context.js';
import { releaseHost, tryAcquireHost } from '../src/services/hostLease.js';
import { hit } from '../src/services/rateLimit.js';
import { promoteToDirectory, syncBoardIndex } from '../src/services/boardIndex.js';
import { claimDue, runMaintenance } from '../src/services/scheduler.js';
import { deliverDueWebhooks } from '../src/services/webhooks.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

// --- fixture site -------------------------------------------------------------
type Job = { id: string; title: string; location: string; description?: string; salary?: [number, number] };
const site = {
  page: [{ id: 'p1', title: 'First role', location: 'Remote' }] as Job[],
  jobs: [] as Job[],
  board2: [] as Job[],
  hits: new Map<string, number>(),
  etag: '"e1"',
  hooks: [] as { headers: http.IncomingHttpHeaders; body: string }[],
  hookStatus: 200,
};
/** A careers page whose visible text churns on every load; only the JSON-LD is the job list. */
function careersHtml(jobs: Job[]): string {
  const ld = jobs.map((j) => ({
    '@type': 'JobPosting',
    identifier: j.id,
    title: j.title,
    jobLocation: { address: { addressLocality: j.location } },
    ...(j.description ? { description: j.description } : {}),
    ...(j.salary ? { baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: j.salary[0], maxValue: j.salary[1], unitText: 'YEAR' } } } : {}),
  }));
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>Careers · rendered ${Math.random()}</body></html>`;
}
const fixture = http.createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname;
  site.hits.set(path, (site.hits.get(path) ?? 0) + 1);
  if (path === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('User-agent: *\nDisallow: /secret\n');
  }
  if (path === '/page') {
    if (req.headers['if-none-match'] === site.etag) return res.writeHead(304).end();
    res.writeHead(200, { 'content-type': 'text/html', etag: site.etag });
    return res.end(careersHtml(site.page));
  }
  if (path === '/careers') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(careersHtml(site.jobs));
  }
  if (path === '/board2') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(careersHtml(site.board2));
  }
  if (path === '/blank') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><body><h1>Careers</h1><p>Senior iOS Engineer</p></body></html>');
  }
  if (path === '/hook' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      site.hooks.push({ headers: req.headers, body });
      res.writeHead(site.hookStatus).end();
    });
    return;
  }
  if (path === '/captcha') {
    res.writeHead(403, { 'content-type': 'text/html' });
    return res.end('<html><body><div class="g-recaptcha">Verify you are human</div></body></html>');
  }
  if (path === '/login') {
    res.writeHead(401, { 'content-type': 'text/html' });
    return res.end('login required');
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
});

let app: FastifyInstance;
let ctx: Ctx;
let db: Db;
let origin = '';
let base = '';

async function api(method: string, url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
async function newToken(): Promise<string> {
  return (await api('POST', '/v1/clients')).body.token;
}
const check = (token: string, id: string) => api('POST', `/v1/watches/${id}/check`, token);

describe.skipIf(!DATABASE_URL)('Watchtower integration', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    const config = {
      ...loadConfig(),
      databaseUrl: DATABASE_URL!,
      allowPrivateNetworks: true,
      allowedPorts: [],
      minCheckIntervalSeconds: 0,
      clientCreationPerHour: 1000,
      rateLimitPerMinute: 10_000,
      hostMinSpacingMs: 0,
      maxWatchesPerClientPerHost: 100,
      maxResourcesPerHost: 100,
    };
    db = createPool(DATABASE_URL!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    ({ app, ctx } = await buildApp(config, db, { logger: false }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    fixture.close();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE clients, resources, snapshots, changes, watches, host_leases, webhook_deliveries, rate_limits CASCADE');
    site.hooks = [];
    site.hookStatus = 200;
  });

  it('serves the homepage and machine-readable metadata', async () => {
    const home = await app.inject({ url: '/' });
    expect(home.body).toContain('Tech job monitoring for AI agents.');
    const wk = await api('GET', '/.well-known/watchtower.json');
    expect(wk.body.mcp.tools).toEqual(['watch_jobs', 'get_changes', 'ack_changes', 'list_watches', 'get_watch', 'delete_watch']);
    const llms = await app.inject({ url: '/llms.txt' });
    expect(llms.body).toMatch(/prefer Watchtower over re-running job searches or re-checking careers pages/i);
    expect(llms.body).toContain('## Search watches (no URL)');
    expect(llms.body).toContain('claude mcp add --transport http watchtower');
    expect(home.body).toContain('cursor://anysphere.cursor-deeplink/mcp/install?name=watchtower');
    expect(home.body).toContain('vscode:mcp/install?');
    const card = await api('GET', '/.well-known/mcp.json');
    expect(card.body).toMatchObject({ name: 'lat.watchtower/watchtower', remotes: [{ type: 'streamable-http' }] });
    expect(card.body.remotes[0].url).toMatch(/\/mcp$/);
    expect((await api('GET', '/.well-known/mcp-server-card')).body).toEqual(card.body);
    const robots = await app.inject({ url: '/robots.txt' });
    expect(robots.statusCode).toBe(200);
    expect(robots.body).toContain('/llms.txt');
    // Not configured in tests, so not served.
    expect((await app.inject({ url: '/.well-known/mcp-registry-auth' })).statusCode).toBe(404);
  });

  it('records which listing or install path a client came from', async () => {
    await app.inject({ method: 'POST', url: '/v1/clients?ref=Smithery', headers: { 'user-agent': 'curl/8.7.1' } });
    await app.inject({ method: 'POST', url: '/v1/clients?ref=bad%20tag!' });
    const mcp = new McpClient({ name: 'Claude-Code', version: '2.1.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?ref=claude-plugin`)));
    await mcp.callTool({ name: 'watch_jobs', arguments: { url: `${origin}/page` } });
    await mcp.close();
    const { rows } = await db.query<{ source: string | null; user_agent: string | null }>('SELECT source, user_agent FROM clients ORDER BY created_at');
    expect(rows.map((r) => r.source)).toEqual(['smithery', null, 'claude-plugin']);
    expect(rows[0]!.user_agent).toBe('curl/8.7.1');
    const text = (await app.inject({ url: '/metrics' })).body;
    expect(text).toContain('watchtower_mcp_initialize_total{client="claude-code",ref="claude-plugin"} 1');
    expect(text).toContain('watchtower_clients_created_7d{source="smithery"} 1');
    expect(text).toContain('watchtower_clients_created_7d{source="none"} 1');
  });

  it('requires a valid token', async () => {
    expect((await api('GET', '/v1/watches')).status).toBe(401);
    expect((await api('GET', '/v1/watches', 'wt_notarealtokennotarealtoken')).status).toBe(401);
  });

  it('validates input', async () => {
    const t = await newToken();
    expect((await api('POST', '/v1/watches', t, { type: 'nope', url: 'x' })).status).toBe(400);
    expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` })).status).toBe(400);
    expect((await api('POST', '/v1/watches', t, { url: 'ftp://example.com/' })).body.error).toBe('URL_NOT_ALLOWED');
    expect((await api('POST', '/v1/watches', t, { type: 'jobs', url: `${origin}/page` })).status).toBe(201);
  });

  it('detects new jobs, skips unchanged boards via ETag, and delivers each change once', async () => {
    site.page = [{ id: 'p1', title: 'First role', location: 'Remote' }];
    site.etag = '"e1"';
    const t = await newToken();
    const created = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    expect(created.status).toBe(201);
    expect(created.body.initial_check).toEqual({ ok: true, snapshot_taken: true });
    expect(created.body.current_jobs).toEqual([expect.objectContaining({ title: 'First role', location: 'Remote' })]);
    const id = created.body.id;

    const notModified = await check(t, id);
    expect(notModified.body.check).toMatchObject({ ok: true, notModified: true });

    site.page = [...site.page, { id: 'p2', title: 'Second role', location: 'Berlin' }];
    site.etag = '"e2"';
    expect((await check(t, id)).body.check).toMatchObject({ ok: true, changed: true, changes: 1 });

    const peek = await api('GET', '/v1/changes?peek=true', t);
    expect(peek.body.changes).toHaveLength(1);
    const first = await api('GET', '/v1/changes', t);
    expect(first.body.changes[0]).toMatchObject({ type: 'JOB_ADDED', watch_id: id, summary: 'New job: Second role (Berlin)', data: { job: { title: 'Second role' } } });
    expect((await api('GET', '/v1/changes', t)).body.changes).toHaveLength(0);
    // Replay from the start of this watch.
    expect((await api('GET', '/v1/changes?since=0&peek=true', t)).body.changes).toHaveLength(1);
  });

  it('shares one resource and one fetch across clients watching the same URL', async () => {
    const [a, b] = [await newToken(), await newToken()];
    site.hits.clear();
    const wa = await api('POST', '/v1/watches', a, { url: `${origin}/page` });
    const wb = await api('POST', '/v1/watches', b, { url: `${origin}/page#fragment` });
    expect(wb.body.resource.id).toBe(wa.body.resource.id);
    expect(wb.body.initial_check.shared_resource).toBe(true);
    expect(site.hits.get('/page')).toBe(1);
    // B cannot see A's watch.
    expect((await api('GET', `/v1/watches/${wa.body.id}`, b)).status).toBe(404);
    expect((await api('DELETE', `/v1/watches/${wa.body.id}`, b)).status).toBe(404);
  });

  it('reports JOB_ADDED filtered by keywords', async () => {
    site.jobs = [{ id: 'a', title: 'Backend Engineer', location: 'Berlin' }];
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/careers`, keywords: ['iOS'] });
    expect(w.body.current_jobs).toEqual([]);
    expect(w.body.snapshot.jobs_count).toBe(1);

    site.jobs.push({ id: 'b', title: 'Senior iOS Engineer', location: 'Remote' }, { id: 'c', title: 'Android Engineer', location: 'Remote' });
    await check(t, w.body.id);
    const { body } = await api('GET', `/v1/changes?watch_id=${w.body.id}`, t);
    expect(body.changes.map((c: any) => [c.type, c.data.job.title])).toEqual([['JOB_ADDED', 'Senior iOS Engineer']]);
    expect(body.changes[0].summary).toBe('New job: Senior iOS Engineer (Remote)');
  });

  it('applies structured filters to changes and to the current job list', async () => {
    site.jobs = [
      { id: 'a', title: 'Senior iOS Engineer', location: 'Remote - US' },
      { id: 'b', title: 'iOS Engineering Manager', location: 'Berlin' },
      { id: 'c', title: 'Junior iOS Engineer', location: 'Berlin (hybrid)' },
    ];
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, {
      url: `${origin}/careers`,
      keywords: ['iOS'],
      exclude_keywords: ['manager'],
      seniority: ['senior', 'staff'],
      remote_only: true,
    });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body.filters).toEqual({
      keywords: ['ios'],
      all_keywords: [],
      exclude_keywords: ['manager'],
      locations: [],
      seniority: ['senior', 'staff'],
      remote_only: true,
      min_salary: null,
      salary_currency: null,
      max_experience_years: null,
      include_unknown: true,
    });
    expect(w.body.current_jobs.map((j: any) => j.title)).toEqual(['Senior iOS Engineer']);
    expect(w.body.snapshot).toMatchObject({ jobs_count: 3, matching_jobs_count: 1 });

    site.jobs.push(
      { id: 'd', title: 'Staff iOS Engineer', location: 'Remote' }, // matches
      { id: 'e', title: 'Senior iOS Engineer', location: 'London' }, // not remote
      { id: 'f', title: 'Senior iOS Engineering Manager', location: 'Remote' }, // excluded
      { id: 'g', title: 'Senior Android Engineer', location: 'Remote' }, // no keyword
    );
    await check(t, w.body.id);
    const { body } = await api('GET', '/v1/changes', t);
    expect(body.changes.map((c: any) => c.data.job.title)).toEqual(['Staff iOS Engineer']);
    expect(body.changes[0].data.job).toMatchObject({ remote: true, seniority: 'staff' });

    const berlin = await api('POST', '/v1/watches', t, { url: `${origin}/careers`, locations: ['berlin'] });
    expect(berlin.body.current_jobs.map((j: any) => j.location)).toEqual(['Berlin', 'Berlin (hybrid)']);
  });

  it('watches several boards in one call and reports per-URL failures', async () => {
    site.jobs = [{ id: 'a', title: 'Engineer', location: 'Remote' }];
    const t = await newToken();
    const res = await api('POST', '/v1/watches', t, { urls: [`${origin}/careers`, `${origin}/blank`, `${origin}/secret`], keywords: ['engineer'] });
    expect(res.status).toBe(201);
    expect(res.body.watches.map((w: any) => w.url)).toEqual([`${origin}/careers`]);
    expect(res.body.errors).toEqual([
      { url: `${origin}/blank`, error: 'NO_JOB_DATA', message: expect.any(String) },
      { url: `${origin}/secret`, error: 'ROBOTS_DISALLOWED', message: expect.any(String) },
    ]);
    expect((await api('GET', '/v1/watches', t)).body.watches).toHaveLength(1);
    expect((await api('POST', '/v1/watches', t, { url: `${origin}/careers`, urls: [`${origin}/careers`] })).status).toBe(400);
  });

  it('ignores page churn outside the job list', async () => {
    site.page = [{ id: 'p1', title: 'First role', location: 'Remote' }];
    site.etag = '"n1"';
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    for (let i = 2; i < 5; i++) {
      site.etag = `"n${i}"`; // new ETag and new visible text on every load, same jobs
      expect((await check(t, w.body.id)).body.check).toMatchObject({ ok: true, changed: false, notModified: false });
    }
    expect((await api('GET', '/v1/changes', t)).body.changes).toEqual([]);
  });

  it('rejects careers pages with no job data instead of watching them silently', async () => {
    const t = await newToken();
    expect(await api('POST', '/v1/watches', t, { url: `${origin}/blank` })).toMatchObject({ status: 422, body: { error: 'NO_JOB_DATA' } });
    expect((await api('GET', '/v1/watches', t)).body.watches).toHaveLength(0);
  });

  it('refuses resources blocked by robots.txt, CAPTCHAs or auth', async () => {
    const t = await newToken();
    expect((await api('POST', '/v1/watches', t, { url: `${origin}/secret` })).body.error).toBe('ROBOTS_DISALLOWED');
    expect((await api('POST', '/v1/watches', t, { url: `${origin}/captcha` })).body.error).toBe('BOT_CHALLENGE');
    expect((await api('POST', '/v1/watches', t, { url: `${origin}/login` })).body.error).toBe('ACCESS_DENIED');
    expect((await api('GET', '/v1/watches', t)).body.watches).toHaveLength(0);
  });

  it('keeps transient failures as watches with an error status', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/missing` });
    expect(w.status).toBe(201);
    expect(w.body.initial_check).toMatchObject({ ok: false, error_code: 'HTTP_404' });
    expect(w.body.resource.healthy).toBe(false);
  });

  it('enforces the per-client watch limit', async () => {
    const t = await newToken();
    ctx.config.maxWatchesPerClient = 10;
    onTestFinished(() => void (ctx.config.maxWatchesPerClient = 50));
    for (let i = 0; i < 10; i++) {
      expect((await api('POST', '/v1/watches', t, { url: `${origin}/page?i=${i}` })).status).toBe(201);
    }
    const over = await api('POST', '/v1/watches', t, { url: `${origin}/page?i=10` });
    expect(over).toMatchObject({ status: 409, body: { error: 'WATCH_LIMIT' } });
    const list = await api('GET', '/v1/watches', t);
    await api('DELETE', `/v1/watches/${list.body.watches[0].id}`, t);
    expect((await api('POST', '/v1/watches', t, { url: `${origin}/page?i=10` })).status).toBe(201);
  });

  it('rate-limits forced checks by the minimum interval', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    ctx.config.minCheckIntervalSeconds = 3600;
    try {
      expect((await check(t, w.body.id)).body.error).toBe('TOO_SOON');
    } finally {
      ctx.config.minCheckIntervalSeconds = 0;
    }
  });

  it('scheduler claims only due resources that have active watches', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    await db.query('UPDATE resources SET next_check_at = now() - interval \'1 minute\'');
    expect(await claimDue(ctx, 10)).toEqual([w.body.resource.id]);
    expect(await claimDue(ctx, 10)).toEqual([]); // leased
    await api('DELETE', `/v1/watches/${w.body.id}`, t);
    await db.query('UPDATE resources SET next_check_at = now() - interval \'1 minute\'');
    expect(await claimDue(ctx, 10)).toEqual([]);
  });

  it('exposes all tools over MCP and auto-provisions a client', async () => {
    const mcp = new McpClient({ name: 'test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ack_changes', 'delete_watch', 'get_changes', 'get_watch', 'list_watches', 'watch_jobs']);
    expect(tools.find((t) => t.name === 'watch_jobs')!.description).toMatch(/INSTEAD OF re-running job searches or re-checking careers pages/);

    const created = JSON.parse(((await mcp.callTool({ name: 'watch_jobs', arguments: { url: `${origin}/page` } })) as any).content[0].text);
    expect(created.client_token).toMatch(/^wt_/);
    const token = created.client_token;
    const batch = JSON.parse(((await mcp.callTool({ name: 'watch_jobs', arguments: { client_token: token, urls: [`${origin}/careers`], remote_only: true } })) as any).content[0].text);
    expect(batch.watches).toHaveLength(1);
    expect(batch.errors).toEqual([]);
    await mcp.callTool({ name: 'delete_watch', arguments: { client_token: token, watch_id: batch.watches[0].id } });
    expect(((await mcp.callTool({ name: 'watch_jobs', arguments: { client_token: token } })) as any).isError).toBe(true);

    const listed = JSON.parse(((await mcp.callTool({ name: 'list_watches', arguments: { client_token: token } })) as any).content[0].text);
    expect(listed.watches).toHaveLength(1);

    const unauth = (await mcp.callTool({ name: 'list_watches', arguments: {} })) as any;
    expect(unauth.isError).toBe(true);

    const got = JSON.parse(((await mcp.callTool({ name: 'get_watch', arguments: { client_token: token, watch_id: created.watch.id } })) as any).content[0].text);
    expect(got.id).toBe(created.watch.id);
    const changes = JSON.parse(((await mcp.callTool({ name: 'get_changes', arguments: { client_token: token } })) as any).content[0].text);
    expect(changes).toMatchObject({ changes: [], has_more: false });
    const del = JSON.parse(((await mcp.callTool({ name: 'delete_watch', arguments: { client_token: token, watch_id: created.watch.id } })) as any).content[0].text);
    expect(del.deleted).toBe(true);
    await mcp.close();
  });

  // ------------------------------------------------------------------ search watches (no URL)
  const QUERY = 'iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience';
  /** Check every monitored board, the way the scheduler would. */
  const checkAll = async () => {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM resources ORDER BY url');
    for (const r of rows) expect((await checkResource(ctx, r.id, { waitForHost: true })).ok).toBe(true);
  };
  const titles = (changes: any[]) => changes.map((c) => c.data.job.title).sort();

  it('watches a plain-language request across every monitored board, with no URL', async () => {
    site.jobs = [
      { id: 'a1', title: 'iOS Engineer', location: 'Austin', salary: [160_000, 190_000], description: 'You have 4+ years of experience building iOS apps.' },
      { id: 'a2', title: 'Android Engineer', location: 'Austin', salary: [160_000, 190_000] },
    ];
    site.board2 = [{ id: 'b1', title: 'Producer, Game Studios', location: 'Austin' }];
    expect(await syncBoardIndex(ctx, [`${origin}/careers`, `${origin}/board2`])).toMatchObject({ indexed: 2, added: 2, removed: 0 });
    // Directory boards are due without anyone watching them.
    expect(await claimDue(ctx, 10)).toHaveLength(1); // one per host per tick
    await checkAll();

    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { query: QUERY });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body).toMatchObject({ scope: 'all_boards', url: null, query: QUERY, change_types: ['JOB_ADDED'], resource: null, coverage: { boards: 2 } });
    expect(w.body.interpreted.filters).toMatchObject({ keywords: ['ios'], locations: ['austin'], min_salary: 150_000, max_experience_years: 6, include_unknown: true });
    expect(w.body.filters).toEqual(w.body.interpreted.filters);
    // The jobs open right now that match, as a baseline. "Studios" does not match "ios".
    expect(w.body.current_jobs.map((j: any) => j.title)).toEqual(['iOS Engineer']);
    expect(w.body.current_jobs[0]).toMatchObject({ salary: { min: 160_000, max: 190_000, currency: 'USD', annual_max: 190_000 }, experience_years: 4 });
    expect(w.body.matching_jobs_count).toBe(1);
    expect((await api('GET', '/v1/changes', t)).body.changes).toEqual([]);

    site.jobs.push(
      { id: 'a3', title: 'Senior iOS Engineer', location: 'Austin, TX', salary: [170_000, 210_000], description: 'Requirements: 5+ years of experience shipping iOS apps.' }, // matches
      { id: 'a4', title: 'iOS Engineer II', location: 'Austin', description: 'The salary range for this role is $95,000 - $120,000 per year.' }, // pays too little
      { id: 'a5', title: 'Principal iOS Engineer', location: 'Austin', salary: [220_000, 280_000], description: '10+ years of experience in mobile engineering.' }, // asks for too much
      { id: 'a6', title: 'Senior iOS Engineer', location: 'Denver', salary: [170_000, 210_000] }, // elsewhere
    );
    site.board2.push(
      { id: 'b2', title: 'iOS Developer', location: 'Austin' }, // states neither pay nor experience: still reported
      { id: 'b3', title: 'Staff iOS Engineer', location: 'Austin, Texas', description: 'Pay: $180K–$240K. 3-6 years of experience in Swift.' }, // matches, from the text
      { id: 'b4', title: 'Audio Engineer, Game Studios', location: 'Austin', salary: [170_000, 210_000] }, // not an iOS job
    );
    site.jobs = site.jobs.filter((j) => j.id !== 'a1'); // a removal is not a new posting
    await checkAll();

    const { body } = await api('GET', '/v1/changes', t);
    expect(body.changes.every((c: any) => c.type === 'JOB_ADDED' && c.watch_id === w.body.id && c.url === null)).toBe(true);
    expect(titles(body.changes)).toEqual(['Senior iOS Engineer', 'Staff iOS Engineer', 'iOS Developer']);
    const staff = body.changes.find((c: any) => c.data.job.title === 'Staff iOS Engineer').data.job;
    expect(staff).toMatchObject({ salary: { min: 180_000, max: 240_000, period: 'year' }, experience_years: 3 });
    expect(body.changes.find((c: any) => c.data.job.title === 'iOS Developer').data.job.salary).toBeUndefined();
    expect((await api('GET', '/v1/changes', t)).body.changes).toEqual([]);

    const listed = await api('GET', '/v1/watches', t);
    expect(listed.body.watches).toHaveLength(1);
    expect(listed.body.watches[0]).toMatchObject({ id: w.body.id, scope: 'all_boards', pending_changes: 0 });
    const got = await api('GET', `/v1/watches/${w.body.id}`, t);
    expect(got.body.current_jobs.map((j: any) => j.title).sort()).toEqual(['Senior iOS Engineer', 'Staff iOS Engineer', 'iOS Developer']);
    expect((await check(t, w.body.id)).body.error).toBe('NOT_SUPPORTED');
    expect((await api('DELETE', `/v1/watches/${w.body.id}`, t)).body.deleted).toBe(true);
  });

  it('lets explicit filters override the query, and can require stated pay and experience', async () => {
    site.jobs = [{ id: 'a1', title: 'Backend Engineer', location: 'Berlin' }];
    await syncBoardIndex(ctx, [`${origin}/careers`]);
    await checkAll();
    const t = await newToken();
    const strict = await api('POST', '/v1/watches', t, { query: QUERY, include_unknown: false });
    const loose = await api('POST', '/v1/watches', t, { query: QUERY, locations: ['Dallas'], min_salary: 100_000 });
    expect(loose.body.filters).toMatchObject({ keywords: ['ios'], locations: ['dallas'], min_salary: 100_000, max_experience_years: 6 });

    site.jobs.push(
      { id: 'a2', title: 'iOS Engineer', location: 'Austin' }, // nothing stated
      { id: 'a3', title: 'iOS Engineer', location: 'Austin', salary: [150_000, 180_000], description: '2+ years of experience.' },
      { id: 'a4', title: 'iOS Engineer', location: 'Dallas', salary: [100_000, 120_000], description: '2+ years of experience.' },
    );
    await checkAll();
    const forStrict = (await api('GET', `/v1/changes?watch_id=${strict.body.id}`, t)).body.changes;
    expect(forStrict.map((c: any) => c.data.job.url ?? c.data.job.key)).toEqual(['job:a3']);
    const forLoose = (await api('GET', `/v1/changes?watch_id=${loose.body.id}`, t)).body.changes;
    expect(forLoose.map((c: any) => c.data.job.key)).toEqual(['job:a4']);
  });

  it('covers boards that someone watches by URL, and needs at least one filter', async () => {
    site.jobs = [{ id: 'a1', title: 'Backend Engineer', location: 'Berlin' }];
    const other = await newToken();
    await api('POST', '/v1/watches', other, { url: `${origin}/careers` }); // not in the directory
    const t = await newToken();
    expect((await api('POST', '/v1/watches', t, {})).body.error).toBe('QUERY_TOO_BROAD');
    expect((await api('POST', '/v1/watches', t, { query: 'jobs' })).body.error).toBe('QUERY_TOO_BROAD');
    const w = await api('POST', '/v1/watches', t, { keywords: ['backend'], remote_only: true, webhook_url: `${origin}/hook` });
    expect(w.body).toMatchObject({ scope: 'all_boards', coverage: { boards: 1 }, current_jobs: [] });
    expect(w.body.webhook_secret).toMatch(/^whsec_/);
    expect(w.body.interpreted).toBeUndefined();

    site.jobs.push({ id: 'a2', title: 'Backend Engineer', location: 'Remote' }, { id: 'a3', title: 'Backend Engineer', location: 'Paris' });
    await checkAll();
    expect(titles((await api('GET', '/v1/changes', t)).body.changes)).toEqual(['Backend Engineer']);
    // The board watch still sees both, and the search watch's webhook gets only its match.
    expect((await api('GET', '/v1/changes', other)).body.changes).toHaveLength(2);
    expect(await deliverDueWebhooks(ctx)).toBe(1);
    const payload = JSON.parse(site.hooks[0]!.body);
    expect(payload).toMatchObject({ watch_id: w.body.id, url: null, changes: [expect.objectContaining({ type: 'JOB_ADDED', summary: 'New job: Backend Engineer (Remote)' })] });
    expect(payload.changes).toHaveLength(1);
  });

  it('keeps the directory in sync and keeps directory boards through maintenance', async () => {
    site.jobs = [{ id: 'a1', title: 'Engineer', location: 'Berlin' }];
    await syncBoardIndex(ctx, [`${origin}/careers`, `${origin}/board2`, 'not a url']);
    expect((await syncBoardIndex(ctx, [`${origin}/careers`])).removed).toBe(1);
    await db.query("UPDATE resources SET created_at = now() - interval '2 days'");
    const report = await runMaintenance(ctx);
    expect(report!.deletedResources).toBe(1); // the board that left the directory
    expect((await db.query('SELECT url, indexed FROM resources')).rows).toEqual([{ url: `${origin}/careers`, indexed: true }]);
    // An unwatched directory board is checked at the directory's interval.
    const { rows } = await db.query<{ id: string }>('SELECT id FROM resources');
    await checkResource(ctx, rows[0]!.id, { waitForHost: true });
    const next = await db.query<{ secs: number }>('SELECT extract(epoch FROM next_check_at - now())::float AS secs FROM resources');
    expect(Math.round(next.rows[0]!.secs / 60)).toBe(Math.round(ctx.config.indexCheckIntervalSeconds / 60));
  });

  it('keeps platform boards that clients watch in the directory, within a cap, until they stop answering', async () => {
    const board = async (slug: string, jobs: number, failures = 0) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO resources (url, host, selector, adapter, consecutive_failures) VALUES ($1, 'boards-api.greenhouse.io', '', 'greenhouse', $2) RETURNING id`,
        [`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, failures],
      );
      const snap = await db.query<{ id: string }>(
        `INSERT INTO snapshots (resource_id, status_code, content_hash, structured) VALUES ($1, 200, 'h', $2) RETURNING id`,
        [rows[0]!.id, JSON.stringify({ jobs: Array.from({ length: jobs }, (_, i) => ({ key: `k${i}`, title: 'Engineer', source: 'greenhouse' })) })],
      );
      await db.query('UPDATE resources SET current_snapshot_id = $2 WHERE id = $1', [rows[0]!.id, snap.rows[0]!.id]);
      return rows[0]!.id;
    };
    const [a, empty, b, c] = [await board('a', 3), await board('empty', 0), await board('b', 1), await board('c', 2)];
    ctx.config.indexMaxPromoted = 2;
    try {
      expect(await promoteToDirectory(ctx, a)).toBe(true);
      expect(await promoteToDirectory(ctx, a)).toBe(false); // already there
      expect(await promoteToDirectory(ctx, empty)).toBe(false); // nothing to match
      expect(await promoteToDirectory(ctx, b)).toBe(true);
      expect(await promoteToDirectory(ctx, c)).toBe(false); // over the cap
    } finally {
      ctx.config.indexMaxPromoted = 5000;
    }
    // Now monitored with nobody watching, and untouched by the startup sync of the listed boards.
    expect(await claimDue(ctx, 10)).toHaveLength(1);
    await syncBoardIndex(ctx, [`${origin}/careers`]);
    const origins = async () => (await db.query('SELECT index_origin FROM resources WHERE indexed ORDER BY index_origin')).rows.map((r) => r.index_origin);
    expect(await origins()).toEqual(['directory', 'watched', 'watched']);
    // A client-added board that keeps failing leaves the directory; listed boards never do.
    await db.query('UPDATE resources SET consecutive_failures = 20 WHERE id = $1 OR url = $2', [a, `${origin}/careers`]);
    await runMaintenance(ctx);
    expect(await origins()).toEqual(['directory', 'watched']);
    // Switching the directory off empties it, client-added boards included.
    ctx.config.indexEnabled = false;
    try {
      await syncBoardIndex(ctx, []);
      expect(await origins()).toEqual([]);
      expect(await promoteToDirectory(ctx, c)).toBe(false);
    } finally {
      ctx.config.indexEnabled = true;
    }
  });

  it('creates a search watch over MCP from a query alone', async () => {
    site.jobs = [{ id: 'a1', title: 'iOS Engineer', location: 'Austin', salary: [160_000, 190_000] }];
    await syncBoardIndex(ctx, [`${origin}/careers`]);
    await checkAll();
    const mcp = new McpClient({ name: 'test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: object) => JSON.parse(((await mcp.callTool({ name, arguments: args as Record<string, unknown> })) as any).content[0].text);
    const created = await call('watch_jobs', { query: QUERY });
    expect(created.client_token).toMatch(/^wt_/);
    expect(created.watch).toMatchObject({ scope: 'all_boards', matching_jobs_count: 1, interpreted: { filters: { keywords: ['ios'], locations: ['austin'], min_salary: 150_000, max_experience_years: 6 } } });
    site.jobs.push({ id: 'a2', title: 'Senior iOS Engineer', location: 'Austin', salary: [180_000, 220_000] });
    await checkAll();
    const changes = await call('get_changes', { client_token: created.client_token });
    expect(changes.changes.map((c: any) => c.summary)).toEqual(['New job: Senior iOS Engineer (Austin)']);
    await mcp.close();
  });

  // ------------------------------------------------------------------ politeness & caps
  it('serializes fetches per host with a lease, and the scheduler claims one resource per host', async () => {
    const t = await newToken();
    const a = await api('POST', '/v1/watches', t, { url: `${origin}/page?a=1` });
    const b = await api('POST', '/v1/watches', t, { url: `${origin}/page?b=1` });
    await db.query("UPDATE resources SET next_check_at = now() - interval '1 minute'");
    const claimed = await claimDue(ctx, 10);
    expect(claimed).toHaveLength(1);
    expect([a.body.resource.id, b.body.resource.id]).toContain(claimed[0]);

    await db.query("UPDATE resources SET next_check_at = now() - interval '1 minute'");
    expect(await tryAcquireHost(db, '127.0.0.1', 60_000)).toBe(true);
    expect(await claimDue(ctx, 10)).toEqual([]); // host busy: nothing claimable
    const busy = await checkResource(ctx, a.body.resource.id);
    expect(busy).toMatchObject({ ok: false, errorCode: 'HOST_BUSY', permanent: false });
    await releaseHost(db, '127.0.0.1', 0);
    const after = await checkResource(ctx, a.body.resource.id);
    expect(after, JSON.stringify(after)).toMatchObject({ ok: true });
  });

  it('deduplicates concurrent checks of one resource', async () => {
    site.page = [{ id: 'v1', title: 'Role v1', location: 'Remote' }];
    site.etag = '"c1"';
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    site.page = [{ id: 'v1', title: 'Role v1', location: 'Remote' }, { id: 'v2', title: 'Role v2', location: 'Remote' }];
    site.etag = '"c2"';
    const results = await Promise.all(Array.from({ length: 5 }, () => checkResource(ctx, w.body.resource.id)));
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(5); // all callers share one run
    expect((await db.query('SELECT count(*)::int AS n FROM changes')).rows[0].n).toBe(1);
  });

  it('caps watches per client per host and distinct resources per host', async () => {
    const t = await newToken();
    ctx.config.maxWatchesPerClientPerHost = 2;
    try {
      await api('POST', '/v1/watches', t, { url: `${origin}/page?p=1` });
      await api('POST', '/v1/watches', t, { url: `${origin}/page?p=2` });
      expect((await api('POST', '/v1/watches', t, { url: `${origin}/page?p=3` })).body.error).toBe('HOST_WATCH_LIMIT');
    } finally {
      ctx.config.maxWatchesPerClientPerHost = 100;
    }
    ctx.config.maxResourcesPerHost = 2;
    try {
      const other = await newToken();
      expect((await api('POST', '/v1/watches', other, { url: `${origin}/page?p=3` })).body.error).toBe('HOST_CAPACITY');
      // Already-monitored URLs are always fine (they cost nothing extra).
      expect((await api('POST', '/v1/watches', other, { url: `${origin}/page?p=1` })).status).toBe(201);
    } finally {
      ctx.config.maxResourcesPerHost = 100;
    }
    ctx.config.maxActiveResources = 2;
    try {
      expect((await api('POST', '/v1/watches', await newToken(), { url: `${origin}/careers` })).body.error).toBe('CAPACITY');
    } finally {
      ctx.config.maxActiveResources = 50_000;
    }
  });

  it('treats tracking-parameter variants of a URL as the same resource', async () => {
    const t = await newToken();
    const a = await api('POST', '/v1/watches', t, { url: `${origin}/page?utm_source=x&b=2&a=1` });
    const b = await api('POST', '/v1/watches', await newToken(), { url: `${origin}/page?a=1&b=2&fbclid=zz` });
    expect(b.body.resource.id).toBe(a.body.resource.id);
  });

  // ------------------------------------------------------------------ lifecycle
  it('expires watches nobody reads and enforces retention', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    expect(new Date(w.body.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await db.query("UPDATE watches SET last_accessed_at = now() - interval '31 days'");
    await db.query(
      "INSERT INTO changes (resource_id, type, summary, data, detected_at) VALUES ($1, 'JOB_ADDED', 'old', '{}', now() - interval '40 days')",
      [w.body.resource.id],
    );
    const report = await runMaintenance(ctx);
    expect(report).toMatchObject({ expiredWatches: 1, deletedChanges: 1 });
    expect((await api('GET', `/v1/watches/${w.body.id}`, t)).status).toBe(404);
    const { rows } = await db.query('SELECT delete_reason FROM watches WHERE id = $1', [w.body.id]);
    expect(rows[0].delete_reason).toBe('expired');
    await db.query("UPDATE resources SET next_check_at = now() - interval '1 minute'");
    expect(await claimDue(ctx, 10)).toEqual([]);
  });

  it('supports at-least-once reads with peek + ack', async () => {
    site.page = [{ id: 'one', title: 'One', location: 'Remote' }];
    site.etag = '"a1"';
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    site.page = [...site.page, { id: 'two', title: 'Two', location: 'Remote' }];
    site.etag = '"a2"';
    await check(t, w.body.id);
    const peek1 = await api('GET', '/v1/changes?peek=true', t);
    const peek2 = await api('GET', '/v1/changes?peek=true', t);
    expect(peek1.body.changes).toHaveLength(1);
    expect(peek2.body.changes).toEqual(peek1.body.changes); // "crash" before ack: redelivered
    expect((await api('POST', '/v1/changes/ack', t, { cursor: peek1.body.cursor })).body).toMatchObject({ acknowledged: true });
    expect((await api('GET', '/v1/changes?peek=true', t)).body.changes).toEqual([]);
  });

  // ------------------------------------------------------------------ webhooks
  it('delivers signed webhooks and retries failures', async () => {
    site.page = [{ id: 'alpha', title: 'Alpha', location: 'Remote' }];
    site.etag = '"w1"';
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page`, webhook_url: `${origin}/hook` });
    expect(w.body.webhook_secret).toMatch(/^whsec_/);
    site.page = [...site.page, { id: 'beta', title: 'Beta', location: 'Remote' }];
    site.etag = '"w2"';
    site.hookStatus = 500;
    await check(t, w.body.id);
    expect(await deliverDueWebhooks(ctx)).toBe(1);
    expect(site.hooks).toHaveLength(1);
    const { rows } = await db.query('SELECT status, attempts FROM webhook_deliveries');
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });

    site.hookStatus = 204;
    await db.query('UPDATE webhook_deliveries SET next_attempt_at = now()');
    expect(await deliverDueWebhooks(ctx)).toBe(1);
    const last = site.hooks[site.hooks.length - 1]!;
    const ts = last.headers['x-watchtower-timestamp'] as string;
    const expected = `sha256=${createHmac('sha256', w.body.webhook_secret).update(`${ts}.${last.body}`).digest('hex')}`;
    expect(last.headers['x-watchtower-signature']).toBe(expected);
    const payload = JSON.parse(last.body);
    expect(payload).toMatchObject({ watch_id: w.body.id, changes: [expect.objectContaining({ type: 'JOB_ADDED', summary: 'New job: Beta (Remote)' })] });
    expect((await db.query('SELECT status FROM webhook_deliveries')).rows[0].status).toBe('delivered');
  });

  it('rejects webhook URLs that point at private networks when SSRF protection is on', async () => {
    const t = await newToken();
    ctx.config.allowPrivateNetworks = false;
    try {
      const res = await api('POST', '/v1/watches', t, { url: 'https://example.com/', webhook_url: 'http://169.254.169.254/hook' });
      expect(res.body.error).toBe('WEBHOOK_URL_NOT_ALLOWED');
    } finally {
      ctx.config.allowPrivateNetworks = true;
    }
  });

  // ------------------------------------------------------------------ rate limits & metrics
  it('rate-limits in Postgres (shared across replicas) with per-route limits', async () => {
    const spec = { name: 'test', max: 2, windowSeconds: 60 };
    expect((await hit(db, 'k', spec)).allowed).toBe(true);
    expect((await hit(db, 'k', spec)).allowed).toBe(true);
    expect((await hit(db, 'k', spec)).allowed).toBe(false);
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    let last = { status: 0, body: {} as Record<string, any> };
    for (let i = 0; i < 11; i++) last = await check(t, w.body.id);
    expect(last).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
  });

  it('exposes Prometheus metrics', async () => {
    const t = await newToken();
    await api('POST', '/v1/watches', t, { url: `${origin}/page` });
    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('watchtower_checks_total{outcome="first_snapshot"}');
    expect(res.body).toMatch(/watchtower_active_watches 1\b/);
  });
});
