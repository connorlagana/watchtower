/**
 * The only way Watchtower touches the network.
 *
 * - SSRF-validated URL + connect-time DNS check on every hop
 * - manual redirects (bounded, each hop re-validated)
 * - one overall deadline across all hops
 * - body cap enforced on the *decompressed* bytes (zip-bomb safe)
 * - content-type allowlist: we only diff text-like resources
 */
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Agent, request } from 'undici';
import { createSafeLookup, SsrfError, validateUrl, type SsrfPolicy } from '../security/ssrf.js';

export interface FetchOptions {
  policy: SsrfPolicy;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  headers?: Record<string, string>;
  /** A JSON body to POST instead of a GET (job-board search APIs). POSTs never follow redirects. */
  jsonBody?: string;
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  notModified: boolean;
}

export type FetchErrorCode =
  | 'SSRF_BLOCKED'
  | 'TOO_MANY_REDIRECTS'
  | 'BODY_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const TEXTUAL = /^(text\/|application\/(json|ld\+json|xml|xhtml\+xml|rss\+xml|atom\+xml|[a-z0-9.+-]+\+(json|xml)))/i;

const agents = new Map<string, Agent>();
function agentFor(policy: SsrfPolicy, timeoutMs: number): Agent {
  const key = `${policy.allowPrivateNetworks}|${policy.allowedPorts.join(',')}|${timeoutMs}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: createSafeLookup(policy) as never, timeout: timeoutMs },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connections: 16,
    });
    agents.set(key, agent);
  }
  return agent;
}

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** Abandon a response body without leaving an unhandled 'error' event behind. */
function discard(body: Readable): void {
  body.on('error', () => {});
  body.destroy();
}

async function readCapped(stream: Readable, encoding: string | undefined, maxBytes: number): Promise<Buffer> {
  let source: Readable = stream;
  const enc = (encoding ?? '').toLowerCase().trim();
  if (enc === 'gzip' || enc === 'x-gzip') source = stream.pipe(createGunzip());
  else if (enc === 'br') source = stream.pipe(createBrotliDecompress());
  else if (enc === 'deflate') source = stream.pipe(createInflate());

  if (source !== stream) stream.on('error', (err) => source.destroy(err));
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        discard(stream);
        discard(source);
        throw new FetchError('BODY_TOO_LARGE', `response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError('NETWORK_ERROR', `failed reading body: ${(err as Error).message}`);
  }
  return Buffer.concat(chunks);
}

function decode(buf: Buffer, contentType: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  const charset = m?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export async function safeFetch(input: string, opts: FetchOptions): Promise<FetchResult> {
  const dispatcher = agentFor(opts.policy, opts.timeoutMs);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url: URL;
  try {
    url = validateUrl(input, opts.policy);
  } catch (err) {
    throw new FetchError('SSRF_BLOCKED', (err as Error).message);
  }

  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await request(url, {
        method: opts.jsonBody === undefined ? 'GET' : 'POST',
        dispatcher,
        signal,
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/json,application/ld+json,text/plain;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
          ...(opts.jsonBody === undefined ? {} : { 'content-type': 'application/json' }),
          ...opts.headers,
        },
        body: opts.jsonBody,
      });
    } catch (err) {
      const e = err as Error & { code?: string; cause?: unknown };
      if (e instanceof SsrfError || (e.cause as { code?: string })?.code === 'SSRF_BLOCKED' || e.code === 'SSRF_BLOCKED') {
        throw new FetchError('SSRF_BLOCKED', e.message);
      }
      if (signal.aborted || e.name === 'TimeoutError' || /timeout/i.test(e.code ?? '')) {
        throw new FetchError('TIMEOUT', `request timed out after ${opts.timeoutMs}ms`);
      }
      throw new FetchError('NETWORK_ERROR', e.message);
    }

    const headers = flattenHeaders(res.headers as Record<string, string | string[] | undefined>);

    if (res.statusCode >= 300 && res.statusCode < 400 && res.statusCode !== 304 && headers.location) {
      discard(res.body as unknown as Readable);
      if (opts.jsonBody !== undefined) throw new FetchError('TOO_MANY_REDIRECTS', 'POST requests do not follow redirects');
      if (hop >= opts.maxRedirects) throw new FetchError('TOO_MANY_REDIRECTS', `more than ${opts.maxRedirects} redirects`);
      let next: URL;
      try {
        next = validateUrl(new URL(headers.location, url), opts.policy);
      } catch (err) {
        throw new FetchError('SSRF_BLOCKED', `redirect blocked: ${(err as Error).message}`);
      }
      url = next;
      continue;
    }

    if (res.statusCode === 304) {
      discard(res.body as unknown as Readable);
      return { status: 304, finalUrl: url.toString(), headers, contentType: headers['content-type'] ?? '', body: '', notModified: true };
    }

    const contentType = headers['content-type'] ?? '';
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      discard(res.body as unknown as Readable);
      throw new FetchError('BODY_TOO_LARGE', `content-length ${declared} exceeds ${opts.maxBytes} bytes`);
    }
    if (contentType && !TEXTUAL.test(contentType)) {
      discard(res.body as unknown as Readable);
      throw new FetchError('UNSUPPORTED_CONTENT_TYPE', `unsupported content-type ${contentType.split(';')[0]}`);
    }
    const buf = await readCapped(res.body as unknown as Readable, headers['content-encoding'], opts.maxBytes);
    return {
      status: res.statusCode,
      finalUrl: url.toString(),
      headers,
      contentType,
      body: decode(buf, contentType),
      notModified: false,
    };
  }
}

/**
 * POST a small JSON body (webhook delivery) under the same SSRF policy.
 * Redirects are never followed: a webhook endpoint that redirects is a failure.
 */
export async function safePost(
  input: string,
  body: string,
  opts: Pick<FetchOptions, 'policy' | 'timeoutMs' | 'userAgent'> & { headers?: Record<string, string> },
): Promise<{ status: number }> {
  let url: URL;
  try {
    url = validateUrl(input, opts.policy);
  } catch (err) {
    throw new FetchError('SSRF_BLOCKED', (err as Error).message);
  }
  try {
    const res = await request(url, {
      method: 'POST',
      dispatcher: agentFor(opts.policy, opts.timeoutMs),
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { 'user-agent': opts.userAgent, 'content-type': 'application/json', ...opts.headers },
      body,
    });
    discard(res.body as unknown as Readable);
    return { status: res.statusCode };
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e instanceof SsrfError || e.code === 'SSRF_BLOCKED') throw new FetchError('SSRF_BLOCKED', e.message);
    if (e.name === 'TimeoutError' || /timeout/i.test(e.code ?? '')) throw new FetchError('TIMEOUT', `timed out after ${opts.timeoutMs}ms`);
    throw new FetchError('NETWORK_ERROR', e.message);
  }
}
