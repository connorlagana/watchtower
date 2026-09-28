/**
 * The condition evaluator against a local mock of the Messages API, so the real
 * SDK request/parse path is exercised without network access or an API key.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createConditionEvaluator } from '../src/services/conditions.js';

let requests: { headers: http.IncomingHttpHeaders; body: any }[] = [];
let reply: (body: any) => { status: number; json: unknown } = () => ({ status: 500, json: {} });

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    requests.push({ headers: req.headers, body });
    const r = reply(body);
    res.writeHead(r.status, { 'content-type': 'application/json', 'request-id': 'req_test' });
    res.end(JSON.stringify(r.json));
  });
});

const message = (text: string, stop_reason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const changes = [
  { type: 'JOB_ADDED' as const, summary: 'New job: Senior iOS Engineer (Remote)', data: { job: { title: 'Senior iOS Engineer' } } },
  { type: 'JOB_ADDED' as const, summary: 'New job: Junior Designer', data: { job: { title: 'Junior Designer' } } },
];

describe('LLM condition evaluator', () => {
  let evaluator: ReturnType<typeof createConditionEvaluator>;

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    evaluator = createConditionEvaluator({ ...loadConfig(), anthropicApiKey: 'sk-test', llmModel: 'claude-opus-5' });
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  });

  it('is disabled without an API key', () => {
    expect(createConditionEvaluator({ ...loadConfig(), anthropicApiKey: null })).toBeNull();
  });

  it('sends one structured-output request and maps verdicts back to changes', async () => {
    requests = [];
    reply = () => ({
      status: 200,
      json: message(JSON.stringify({ results: [{ index: 0, match: true, reason: 'senior role' }, { index: 1, match: false, reason: 'junior' }] })),
    });
    const verdicts = await evaluator!.evaluate('senior roles only', changes);
    expect(verdicts).toEqual([
      { match: true, reason: 'senior role' },
      { match: false, reason: 'junior' },
    ]);
    expect(requests).toHaveLength(1);
    const { body, headers } = requests[0]!;
    expect(body.model).toBe('claude-opus-5');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.fallbacks).toBe('default');
    expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(body.system).toMatch(/untrusted/);
    expect(body.messages[0].content).toContain('Condition: senior roles only');
  });

  it('returns null (caller fails open) on refusal, API errors and unparseable output', async () => {
    reply = () => ({ status: 200, json: message('', 'refusal') });
    expect(await evaluator!.evaluate('x', changes)).toBeNull();
    reply = () => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } });
    expect(await evaluator!.evaluate('x', changes)).toBeNull();
    reply = () => ({ status: 200, json: message('not json') });
    expect(await evaluator!.evaluate('x', changes)).toBeNull();
  });

  it('omits the fallback beta for models that do not support it', async () => {
    requests = [];
    reply = () => ({ status: 200, json: message(JSON.stringify({ results: [] })) });
    const haiku = createConditionEvaluator({ ...loadConfig(), anthropicApiKey: 'sk-test', llmModel: 'claude-haiku-4-5' });
    await haiku!.evaluate('x', changes);
    expect(requests[0]!.body.fallbacks).toBeUndefined();
  });
});
