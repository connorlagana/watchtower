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
import { claimDue } from '../src/services/scheduler.js';
import type { Ctx } from '../src/services/context.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

// --- fixture site -------------------------------------------------------------
const site = {
  page: '<html><head><title>News</title></head><body><main><p>First post</p></main></body></html>',
  jobs: [] as { id: string; title: string; location: string }[],
  events: ['2026-10-01'],
  hits: new Map<string, number>(),
  etag: '"e1"',
};
const fixture = http.createServer((req, res) => {
  const path = req.url ?? '/';
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
    await db.query('TRUNCATE clients, resources, snapshots, changes, watches CASCADE');
  });

  it('serves the homepage and machine-readable metadata', async () => {
    const home = await app.inject({ url: '/' });
    expect(home.body).toContain('Stop repeatedly browsing the same pages.');
    const wk = await api('GET', '/.well-known/watchtower.json');
    expect(wk.body.mcp.tools).toEqual(['watch_url', 'watch_jobs', 'watch_events', 'get_changes', 'list_watches', 'get_watch', 'delete_watch']);
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
    site.events = ['2026-10-01'];
    const t = await newToken();
    const w = await api('POST', '/v1/watches', t, { type: 'events', url: `${origin}/tour` });
    expect(w.body.current_events).toHaveLength(1);
    site.events.push('2026-12-24');
    await check(t, w.body.id);
    const { body } = await api('GET', '/v1/changes', t);
    expect(body.changes).toEqual([expect.objectContaining({ type: 'EVENT_ADDED', data: { event: expect.objectContaining({ start_date: '2026-12-24' }) } })]);
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
    expect(tools.map((t) => t.name).sort()).toEqual(['delete_watch', 'get_changes', 'get_watch', 'list_watches', 'watch_events', 'watch_jobs', 'watch_url']);
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
});
