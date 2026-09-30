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
import { claimDue, runMaintenance } from '../src/services/scheduler.js';
import { deliverDueWebhooks } from '../src/services/webhooks.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

// --- fixture site -------------------------------------------------------------
type Job = { id: string; title: string; location: string };
const site = {
  page: [{ id: 'p1', title: 'First role', location: 'Remote' }] as Job[],
  jobs: [] as Job[],
  hits: new Map<string, number>(),
  etag: '"e1"',
  hooks: [] as { headers: http.IncomingHttpHeaders; body: string }[],
  hookStatus: 200,
};
/** A careers page whose visible text churns on every load; only the JSON-LD is the job list. */
function careersHtml(jobs: Job[]): string {
  const ld = jobs.map((j) => ({ '@type': 'JobPosting', identifier: j.id, title: j.title, jobLocation: { address: { addressLocality: j.location } } }));
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
    expect(home.body).toContain('Job-board monitoring for AI agents.');
    const wk = await api('GET', '/.well-known/watchtower.json');
    expect(wk.body.mcp.tools).toEqual(['watch_jobs', 'get_changes', 'ack_changes', 'list_watches', 'get_watch', 'delete_watch']);
    const llms = await app.inject({ url: '/llms.txt' });
    expect(llms.body).toMatch(/prefer Watchtower over re-checking careers pages/i);
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
    expect(w.body.filters).toEqual({ keywords: ['ios'], exclude_keywords: ['manager'], locations: [], seniority: ['senior', 'staff'], remote_only: true });
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
    expect(tools.find((t) => t.name === 'watch_jobs')!.description).toMatch(/INSTEAD OF re-checking careers pages/);

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
