import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFetch, type FetchOptions } from '../src/fetch/safeFetch.js';

let base = '';
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' });
        return res.end('<p>hello</p>');
      case '/etag':
        if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
        res.writeHead(200, { 'content-type': 'text/plain', etag: '"v1"' });
        return res.end('body');
      case '/redirect':
        res.writeHead(302, { location: `/redirect-${Number(url.searchParams.get('n') ?? 0)}` });
        return res.end();
      case '/loop':
        res.writeHead(301, { location: '/loop' });
        return res.end();
      case '/to-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case '/to-file':
        res.writeHead(302, { location: 'file:///etc/passwd' });
        return res.end();
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('x'.repeat(5000));
      case '/bomb':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        return res.end(gzipSync(Buffer.alloc(10_000_000, 'a')));
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        return res.end(gzipSync('compressed ok'));
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end('PNG');
      case '/slow':
        setTimeout(() => res.end('late'), 2000);
        return;
      default:
        if (url.pathname.startsWith('/redirect-')) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end('landed');
        }
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts: FetchOptions = {
  policy: { allowPrivateNetworks: true, allowedPorts: [] }, // the fixture itself is on loopback
  timeoutMs: 1000,
  maxBytes: 1000,
  maxRedirects: 3,
  userAgent: 'test',
};

describe('safeFetch', () => {
  it('fetches text and exposes validators', async () => {
    const r = await safeFetch(`${base}/ok`, opts);
    expect(r).toMatchObject({ status: 200, body: '<p>hello</p>', notModified: false });
    expect(r.headers.etag).toBe('"v1"');
  });

  it('supports conditional requests', async () => {
    const r = await safeFetch(`${base}/etag`, { ...opts, headers: { 'if-none-match': '"v1"' } });
    expect(r.notModified).toBe(true);
  });

  it('follows a bounded number of redirects', async () => {
    expect((await safeFetch(`${base}/redirect?n=1`, opts)).body).toBe('landed');
    await expect(safeFetch(`${base}/loop`, opts)).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('re-validates redirect targets', async () => {
    const strictButLocalOk = { ...opts, policy: { allowPrivateNetworks: false, allowedPorts: [] } };
    // Even the first hop is refused under the strict policy...
    await expect(safeFetch(`${base}/to-metadata`, strictButLocalOk)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    // ...and a redirect to a non-http scheme is refused even in permissive mode.
    await expect(safeFetch(`${base}/to-file`, opts)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('enforces the body size limit, including after decompression', async () => {
    await expect(safeFetch(`${base}/big`, opts)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    await expect(safeFetch(`${base}/bomb`, opts)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect((await safeFetch(`${base}/gzip`, opts)).body).toBe('compressed ok');
  });

  it('refuses non-text content', async () => {
    await expect(safeFetch(`${base}/image`, opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });
  });

  it('times out slow responses', async () => {
    await expect(safeFetch(`${base}/slow`, { ...opts, timeoutMs: 300 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
