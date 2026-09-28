/**
 * Full-stack tests against a real Postgres (TEST_DATABASE_URL) and a local
 * fixture website. Skipped when no test database is configured.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const site = {
  page: '<html><head><title>News</title></head><body><main><p>First post</p></main></body></html>',
  jobs: [] as { id: string; title: string; location: string }[],
  events: ['2030-10-01'],
  hits: new Map<string, number>(),
  etag: '"e1"',
  noisyStable: ['Opening hours: 9-5'],
  feed: ['a'],
  hooks: [] as { headers: http.IncomingHttpHeaders; body: string }[],
  hookStatus: 200,
};
let loads = 0;
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
    return res.end(site.page);
  }
  if (path === '/careers') {
    const ld = site.jobs.map((j) => ({ '@type': 'JobPosting', identifier: j.id, title: j.title, jobLocation: { address: { addressLocality: j.location } } }));
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>Careers</body></html>`);
  }
  if (path === '/tour') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html><body><h1>Tour</h1><ul>${site.events.map((d) => `<li>${d} — Oslo</li>`).join('')}</ul></body></html>`);
  }
  if (path === '/noisy') {
    // Every load shows a different "trending" pick and view counter; only noisyStable is real content.
    loads++;
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<html><body><main><h1>Store</h1><p>Trending now: product #${Math.floor(Math.random() * 1e9)}</p><p>${1000 + loads} people viewed this</p>${site.noisyStable
        .map((l) => `<p>${l}</p>`)
        .join('')}</main></body></html>`,
    );
  }
  if (path === '/feed.xml') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    return res.end(`<rss><channel><title>Blog</title>${site.feed.map((k) => `<item><guid>${k}</guid><title>Post ${k}</title></item>`).join('')}</channel></rss>`);
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
    expect(home.body).toContain('Stop repeatedly browsing the same pages.');
    const wk = await api('GET', '/.well-known/watchtower.json');
    expect(wk.body.mcp.tools).toEqual(['watch_url', 'watch_jobs', 'watch_events', 'get_changes', 'ack_changes', 'list_watches', 'get_watch', 'delete_watch']);
    const llms = await app.inject({ url: '/llms.txt' });
    expect(llms.body).toMatch(/prefer Watchtower over repeated browsing/i);
  });

  it('requires a valid token', async () => {
    expect((await api('GET', '/v1/watches')).status).toBe(401);
    expect((await api('GET', '/v1/watches', 'wt_notarealtokennotarealtoken')).status).toBe(401);
  });

  it('validates input', async () => {
    const t = await newToken();
    expect((await api('POST', '/v1/watches', t, { type: 'nope', url: 'x' })).status).toBe(400);
    expect((await api('POST', '/v1/watches', t, { type: 'url', url: 'ftp://example.com/' })).body.error).toBe('URL_NOT_ALLOWED');
    expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page`, selector: '<<<' })).body.error).toBe('INVALID_SELECTOR');
  });

  it('detects page changes, skips unchanged content via ETag, and delivers each change once', async () => {
    site.page = '<html><head><title>News</title></head><body><main><p>First post</p></main></body></html>';
    site.etag = '"e1"';
    const t = await newToken();
    const created = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
    expect(created.status).toBe(201);
    expect(created.body.initial_check).toEqual({ ok: true, snapshot_taken: true });
    expect(created.body.current_text_excerpt).toBe('First post');
    const id = created.body.id;

    const notModified = await check(t, id);
    expect(notModified.body.check).toMatchObject({ ok: true, notModified: true });

    site.page = site.page.replace('<p>First post</p>', '<p>First post</p><p>Second post</p>');
    site.etag = '"e2"';
    expect((await check(t, id)).body.check).toMatchObject({ ok: true, changed: true, changes: 1 });

    const peek = await api('GET', '/v1/changes?peek=true', t);
    expect(peek.body.changes).toHaveLength(1);
    const first = await api('GET', '/v1/changes', t);
    expect(first.body.changes[0]).toMatchObject({ type: 'CONTENT_CHANGED', watch_id: id, data: { added: ['Second post'], removed: [] } });
    expect((await api('GET', '/v1/changes', t)).body.changes).toHaveLength(0);
    // Replay from the start of this watch.
    expect((await api('GET', '/v1/changes?since=0&peek=true', t)).body.changes).toHaveLength(1);
  });

  it('shares one resource and one fetch across clients watching the same URL', async () => {
    const [a, b] = [await newToken(), await newToken()];
    site.hits.clear();
    const wa = await api('POST', '/v1/watches', a, { type: 'url', url: `${origin}/page` });
    const wb = await api('POST', '/v1/watches', b, { type: 'url', url: `${origin}/page#fragment` });
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
    const w = await api('POST', '/v1/watches', t, { type: 'jobs', url: `${origin}/careers`, keywords: ['iOS'] });
    expect(w.body.current_jobs).toEqual([]);
    expect(w.body.snapshot.jobs_count).toBe(1);

    site.jobs.push({ id: 'b', title: 'Senior iOS Engineer', location: 'Remote' }, { id: 'c', title: 'Android Engineer', location: 'Remote' });
    await check(t, w.body.id);
    const { body } = await api('GET', `/v1/changes?watch_id=${w.body.id}`, t);
    expect(body.changes.map((c: any) => [c.type, c.data.job.title])).toEqual([['JOB_ADDED', 'Senior iOS Engineer']]);
    expect(body.changes[0].summary).toBe('New job: Senior iOS Engineer (Remote)');
  });

  it('reports EVENT_ADDED when an event page adds a date', async () => {
    site.events = ['2030-10-01'];
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'events', url: `${origin}/tour` });
    expect(w.body.current_events).toHaveLength(1);
    site.events.push('2030-12-24');
    await check(t, w.body.id);
    const { body } = await api('GET', '/v1/changes', t);
    expect(body.changes).toEqual([expect.objectContaining({ type: 'EVENT_ADDED', data: { event: expect.objectContaining({ start_date: '2030-12-24' }) } })]);
  });

  it('refuses resources blocked by robots.txt, CAPTCHAs or auth', async () => {
    const t = await newToken();
    expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/secret` })).body.error).toBe('ROBOTS_DISALLOWED');
    expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/captcha` })).body.error).toBe('BOT_CHALLENGE');
    expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/login` })).body.error).toBe('ACCESS_DENIED');
    expect((await api('GET', '/v1/watches', t)).body.watches).toHaveLength(0);
  });

  it('keeps transient failures as watches with an error status', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/missing` });
    expect(w.status).toBe(201);
    expect(w.body.initial_check).toMatchObject({ ok: false, error_code: 'HTTP_404' });
    expect(w.body.resource.healthy).toBe(false);
  });

  it('enforces the per-client watch limit', async () => {
    const t = await newToken();
    for (let i = 0; i < 10; i++) {
      expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?i=${i}` })).status).toBe(201);
    }
    const over = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?i=10` });
    expect(over).toMatchObject({ status: 409, body: { error: 'WATCH_LIMIT' } });
    const list = await api('GET', '/v1/watches', t);
    await api('DELETE', `/v1/watches/${list.body.watches[0].id}`, t);
    expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?i=10` })).status).toBe(201);
  });

  it('rate-limits forced checks by the minimum interval', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
    ctx.config.minCheckIntervalSeconds = 3600;
    try {
      expect((await check(t, w.body.id)).body.error).toBe('TOO_SOON');
    } finally {
      ctx.config.minCheckIntervalSeconds = 0;
    }
  });

  it('scheduler claims only due resources that have active watches', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
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
    expect(tools.map((t) => t.name).sort()).toEqual(['ack_changes', 'delete_watch', 'get_changes', 'get_watch', 'list_watches', 'watch_events', 'watch_jobs', 'watch_url']);
    expect(tools.find((t) => t.name === 'watch_url')!.description).toMatch(/INSTEAD OF repeatedly browsing/);

    const created = JSON.parse(((await mcp.callTool({ name: 'watch_url', arguments: { url: `${origin}/page` } })) as any).content[0].text);
    expect(created.client_token).toMatch(/^wt_/);
    const token = created.client_token;

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

  // ------------------------------------------------------------------ noise
  it('ignores content that differs on every load and still reports real changes', async () => {
    site.noisyStable = ['Opening hours: 9-5'];
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/noisy` });
    for (let i = 0; i < 3; i++) {
      expect((await check(t, w.body.id)).body.check).toMatchObject({ ok: true, changed: false });
    }
    expect((await api('GET', '/v1/changes', t)).body.changes).toEqual([]);

    site.noisyStable = ['Opening hours: 10-6'];
    const res = await check(t, w.body.id);
    expect(res.body.check).toMatchObject({ ok: true, changed: true, changes: 1 });
    const { body } = await api('GET', '/v1/changes', t);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].data).toMatchObject({ added: ['Opening hours: 10-6'], removed: ['Opening hours: 9-5'] });
    expect(body.changes[0].data.details[0]).toMatchObject({ kind: 'modified', diff: 'Opening hours: [-9-5-]{+10-6+}' });
  });

  it('reports new feed entries as ITEM_ADDED', async () => {
    site.feed = ['a', 'b'];
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/feed.xml` });
    expect(w.body.snapshot.is_feed).toBe(true);
    expect(w.body.current_items).toHaveLength(2);
    site.feed = ['c', 'a', 'b'];
    await check(t, w.body.id);
    const { body } = await api('GET', '/v1/changes', t);
    expect(body.changes.map((c: any) => [c.type, c.summary])).toEqual([['ITEM_ADDED', 'New item: Post c']]);
  });

  // ------------------------------------------------------------------ politeness & caps
  it('serializes fetches per host with a lease, and the scheduler claims one resource per host', async () => {
    const t = await newToken();
    const a = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?a=1` });
    const b = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?b=1` });
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
    site.page = '<html><body><main><p>v1</p></main></body></html>';
    site.etag = '"c1"';
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
    site.page = '<html><body><main><p>v2</p></main></body></html>';
    site.etag = '"c2"';
    const results = await Promise.all(Array.from({ length: 5 }, () => checkResource(ctx, w.body.resource.id)));
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(5); // all callers share one run
    expect((await db.query('SELECT count(*)::int AS n FROM changes')).rows[0].n).toBe(1);
  });

  it('caps watches per client per host and distinct resources per host', async () => {
    const t = await newToken();
    ctx.config.maxWatchesPerClientPerHost = 2;
    try {
      await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?p=1` });
      await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?p=2` });
      expect((await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?p=3` })).body.error).toBe('HOST_WATCH_LIMIT');
    } finally {
      ctx.config.maxWatchesPerClientPerHost = 100;
    }
    ctx.config.maxResourcesPerHost = 2;
    try {
      const other = await newToken();
      expect((await api('POST', '/v1/watches', other, { type: 'url', url: `${origin}/page?p=3` })).body.error).toBe('HOST_CAPACITY');
      // Already-monitored URLs are always fine (they cost nothing extra).
      expect((await api('POST', '/v1/watches', other, { type: 'url', url: `${origin}/page?p=1` })).status).toBe(201);
    } finally {
      ctx.config.maxResourcesPerHost = 100;
    }
    ctx.config.maxActiveResources = 2;
    try {
      expect((await api('POST', '/v1/watches', await newToken(), { type: 'url', url: `${origin}/tour` })).body.error).toBe('CAPACITY');
    } finally {
      ctx.config.maxActiveResources = 50_000;
    }
  });

  it('treats tracking-parameter variants of a URL as the same resource', async () => {
    const t = await newToken();
    const a = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page?utm_source=x&b=2&a=1` });
    const b = await api('POST', '/v1/watches', await newToken(), { type: 'url', url: `${origin}/page?a=1&b=2&fbclid=zz` });
    expect(b.body.resource.id).toBe(a.body.resource.id);
  });

  // ------------------------------------------------------------------ lifecycle
  it('expires watches nobody reads and enforces retention', async () => {
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
    expect(new Date(w.body.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await db.query("UPDATE watches SET last_accessed_at = now() - interval '31 days'");
    await db.query(
      "INSERT INTO changes (resource_id, type, summary, data, detected_at) VALUES ($1, 'CONTENT_CHANGED', 'old', '{}', now() - interval '40 days')",
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
    site.page = '<html><body><main><p>one</p></main></body></html>';
    site.etag = '"a1"';
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
    site.page = '<html><body><main><p>two</p></main></body></html>';
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
    site.page = '<html><body><main><p>alpha</p></main></body></html>';
    site.etag = '"w1"';
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page`, webhook_url: `${origin}/hook` });
    expect(w.body.webhook_secret).toMatch(/^whsec_/);
    site.page = '<html><body><main><p>beta</p></main></body></html>';
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
    expect(payload).toMatchObject({ watch_id: w.body.id, changes: [expect.objectContaining({ type: 'CONTENT_CHANGED' })] });
    expect((await db.query('SELECT status FROM webhook_deliveries')).rows[0].status).toBe('delivered');
  });

  it('rejects webhook URLs that point at private networks when SSRF protection is on', async () => {
    const t = await newToken();
    ctx.config.allowPrivateNetworks = false;
    try {
      const res = await api('POST', '/v1/watches', t, { type: 'url', url: 'https://example.com/', webhook_url: 'http://169.254.169.254/hook' });
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
    const w = await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
    let last = { status: 0, body: {} as Record<string, any> };
    for (let i = 0; i < 11; i++) last = await check(t, w.body.id);
    expect(last).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
  });

  it('exposes Prometheus metrics', async () => {
    const t = await newToken();
    await api('POST', '/v1/watches', t, { type: 'url', url: `${origin}/page` });
    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('watchtower_checks_total{outcome="first_snapshot"}');
    expect(res.body).toMatch(/watchtower_active_watches 1\b/);
  });
});
