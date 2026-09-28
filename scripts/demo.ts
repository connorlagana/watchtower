/**
 * End-to-end demo of the core Watchtower loop, fully local:
 *
 *   create client -> create watch -> initial snapshot -> source changes
 *   -> Watchtower detects the change -> get_changes (over MCP) returns structured JSON
 *
 * A tiny fixture server plays the part of a company careers page. Because it
 * runs on 127.0.0.1, the demo enables ALLOW_PRIVATE_NETWORKS for this process
 * only (production keeps SSRF protection on).
 *
 *   DATABASE_URL=postgres://... npm run demo
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.ALLOW_PRIVATE_NETWORKS = 'true';
process.env.MIN_CHECK_INTERVAL_SECONDS = '0';
process.env.RUN_SCHEDULER = 'false';

const { loadConfig } = await import('../src/config.js');
const { createPool, migrate } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');

// ---------------------------------------------------------------- fixture site
const jobs = [
  { id: 'eng-101', title: 'Backend Engineer', location: 'Berlin' },
  { id: 'des-202', title: 'Product Designer', location: 'Remote' },
];
function careersPage(): string {
  const ld = jobs.map((j) => ({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    identifier: j.id,
    title: j.title,
    hiringOrganization: { '@type': 'Organization', name: 'Acme Robotics' },
    jobLocation: { '@type': 'Place', address: { addressLocality: j.location } },
    url: `/careers/${j.id}`,
  }));
  return `<!doctype html><html><head><title>Careers at Acme Robotics</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script>window.__session = "${Math.random().toString(36).repeat(4)}";</script></head>
<body><h1>Join Acme Robotics</h1><p>Page rendered ${Math.floor(Math.random() * 50) + 2} minutes ago</p>
<ul>${jobs.map((j) => `<li><a href="/careers/${j.id}">${j.title}</a> — ${j.location}</li>`).join('')}</ul></body></html>`;
}
const fixture = http.createServer((req, res) => {
  if (req.url === '/careers') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(careersPage());
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/careers`;

// ---------------------------------------------------------------- watchtower
const config = { ...loadConfig(), port: 0 };
const db = createPool(config.databaseUrl);
await migrate(db);
const { app } = await buildApp(config, db, { logger: false });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const step = (n: number, title: string) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const show = (v: unknown) => console.log(JSON.stringify(v, null, 2));
async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

try {
  console.log(`Watchtower demo\n  watchtower: ${base}\n  source:     ${siteUrl}`);

  step(1, 'Create an anonymous client');
  const { token } = (await api('POST', '/v1/clients')) as { token: string };
  console.log(`token: ${token.slice(0, 10)}…`);

  step(2, 'Create a job watch ("tell me when a new iOS job appears") — takes the initial snapshot');
  const jobWatch = await api('POST', '/v1/watches', token, { type: 'jobs', url: siteUrl, keywords: ['ios'], label: 'iOS roles at Acme' });
  show({ id: jobWatch.id, initial_check: jobWatch.initial_check, snapshot: jobWatch.snapshot, current_jobs: jobWatch.current_jobs });

  step(3, 'A second watch on the same URL shares the underlying resource (one fetch serves both)');
  const pageWatch = await api('POST', '/v1/watches', token, { type: 'url', url: siteUrl, label: 'Any change to the careers page' });
  show({ id: pageWatch.id, same_resource: (pageWatch.resource as { id: string }).id === (jobWatch.resource as { id: string }).id, initial_check: pageWatch.initial_check });

  step(4, 'Re-check without a real change (new session token + "N minutes ago" noise only)');
  show((await api('POST', `/v1/watches/${jobWatch.id}/check`, token)).check);

  step(5, 'The source changes: Acme posts an iOS role and an Android role');
  jobs.push({ id: 'ios-303', title: 'Senior iOS Engineer', location: 'Remote - US' }, { id: 'and-404', title: 'Android Engineer', location: 'Berlin' });
  console.log(jobs.map((j) => `  - ${j.title} (${j.location})`).join('\n'));

  step(6, 'Watchtower checks the resource (the scheduler does this automatically; forced here)');
  show((await api('POST', `/v1/watches/${jobWatch.id}/check`, token)).check);

  step(7, 'Agent calls get_changes over MCP — only structured changes come back');
  const mcp = new McpClient({ name: 'demo-agent', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const tools = await mcp.listTools();
  console.log(`MCP tools: ${tools.tools.map((t) => t.name).join(', ')}`);
  const result = (await mcp.callTool({ name: 'get_changes', arguments: {} })) as { content: { text: string }[] };
  show(JSON.parse(result.content[0]!.text));

  step(8, 'Calling get_changes again returns nothing new (cursor advanced)');
  const again = (await mcp.callTool({ name: 'get_changes', arguments: {} })) as { content: { text: string }[] };
  show(JSON.parse(again.content[0]!.text));
  await mcp.close();

  for (const w of [jobWatch, pageWatch]) await api('DELETE', `/v1/watches/${w.id}`, token);
  console.log('\nDone. The Android role was filtered out by the "ios" keyword on the job watch; the page watch saw the raw content change.');
} finally {
  await app.close();
  fixture.close();
  await db.end();
}
