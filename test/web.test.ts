/**
 * The website app (/jobs, accounts, alerts) against a real Postgres. Uses its own database next to TEST_DATABASE_URL
 * so it can run alongside the integration tests. Skipped when no test database is configured.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readCookie, safeNext } from '../src/api/web.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import type { JobItem } from '../src/extract/types.js';
import { sendDueDigests, type Email } from '../src/services/alerts.js';
import type { Ctx } from '../src/services/context.js';
import { hashPassword, verifyPassword } from '../src/services/users.js';

const BASE_URL = process.env.TEST_DATABASE_URL;

let app: FastifyInstance;
let ctx: Ctx;
let db: Db;
let board: string;

const job = (key: string, title: string, max?: number, extra: Partial<JobItem> = {}): JobItem => ({
  key,
  title,
  company: 'Acme',
  location: 'San Francisco, CA',
  url: `https://jobs.example/${key}`,
  source: 'greenhouse',
  ...(max ? { salary: { min: max - 60_000, max, currency: 'USD', period: 'year', annual_min: max - 60_000, annual_max: max } } : {}),
  ...extra,
});

const JOBS: JobItem[] = [
  job('a', 'Staff Software Engineer', 340_000),
  job('b', 'Senior iOS Engineer', 310_000),
  job('c', 'Principal Engineer', 450_000, { remote: true }),
  job('d', 'Engineering Manager', 380_000),
  job('e', 'ML Engineer', 305_000),
  job('f', 'Software Engineer', 180_000),
  job('g', 'Designer'),
];

async function cookieFor(email: string, password = 'correct horse'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/web/signup', payload: { email, password } });
  expect(res.statusCode).toBe(201);
  const set = String(res.headers['set-cookie']);
  expect(set).toMatch(/HttpOnly; SameSite=Lax/);
  return set.split(';')[0]!;
}

const search = (body: object, cookie?: string) =>
  app.inject({ method: 'POST', url: '/web/search', payload: body, headers: cookie ? { cookie } : {} });

describe.skipIf(!BASE_URL)('website app', () => {
  beforeAll(async () => {
    const url = new URL(BASE_URL!);
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    const name = `${url.pathname.slice(1)}_web`;
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    url.pathname = `/${name}`;
    db = createPool(url.toString());
    await migrate(db);
    ({ app, ctx } = await buildApp({ ...loadConfig(), databaseUrl: url.toString(), clientCreationPerHour: 1000, rateLimitPerMinute: 10_000, searchPerMinute: 10_000, freeResults: 3 }, db, { logger: false }));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE users, sessions, clients, resources, snapshots, changes, watches, rate_limits, usage_daily, counts_daily CASCADE');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO resources (url, host, selector, adapter, indexed, index_origin) VALUES ('https://boards-api.greenhouse.io/v1/boards/acme/jobs', 'boards-api.greenhouse.io', '', 'greenhouse', true, 'directory') RETURNING id`,
    );
    board = rows[0]!.id;
    const snap = await db.query<{ id: string }>(`INSERT INTO snapshots (resource_id, status_code, content_hash, structured) VALUES ($1, 200, 'h', $2) RETURNING id`, [board, JSON.stringify({ jobs: JOBS })]);
    await db.query('UPDATE resources SET current_snapshot_id = $2 WHERE id = $1', [board, snap.rows[0]!.id]);
  });

  it('serves the pages', async () => {
    const page = await app.inject({ url: '/jobs' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Find the tech jobs paying');
    expect(page.body).toContain('<b>5</b> open tech roles post pay that reaches $300k');
    expect((await app.inject({ url: '/signup?next=/jobs%3Fq%3Dios' })).body).toContain('location.href = "/jobs?q=ios"');
    expect((await app.inject({ url: '/signin?next=https://evil.example' })).body).toContain('location.href = "/jobs"');
    const alerts = await app.inject({ url: '/alerts' });
    expect(alerts.statusCode).toBe(302);
    expect(alerts.headers.location).toBe('/signin?next=%2Falerts');
  });

  it('shows signed-out visitors only the first results, and everything once signed in', async () => {
    const out = await search({ pay300: true });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toMatchObject({ total: 5, locked: true, next_offset: null, signed_in: false });
    expect(out.json().jobs).toHaveLength(3);
    expect(out.json().jobs.every((j: JobItem) => j.salary!.annual_max! >= 300_000)).toBe(true);
    // No way around the limit by paging.
    expect((await search({ pay300: true, offset: 3 })).statusCode).toBe(401);

    const cookie = await cookieFor('Pat@Example.com');
    const inn = (await search({ pay300: true }, cookie)).json();
    expect(inn).toMatchObject({ total: 5, locked: false, signed_in: true });
    expect(inn.jobs).toHaveLength(5);

    // The toggle off: the query alone decides, and unknown pay is kept.
    expect((await search({ query: 'engineer' }, cookie)).json().total).toBe(5); // "Engineering Manager" is not a whole-word match
    expect((await search({ query: 'engineer', remote: true, pay300: true }, cookie)).json().jobs.map((j: JobItem) => j.title)).toEqual(['Principal Engineer']);
    // Nothing typed: tech roles, with or without stated pay.
    expect((await search({}, cookie)).json().jobs.map((j: JobItem) => j.title).sort()).toEqual(['Designer', 'Engineering Manager', 'ML Engineer', 'Principal Engineer', 'Senior iOS Engineer', 'Software Engineer', 'Staff Software Engineer']);
  });

  it('signs up, signs in and out, and refuses bad credentials', async () => {
    await cookieFor('sam@example.com');
    const dup = await app.inject({ method: 'POST', url: '/web/signup', payload: { email: 'SAM@example.com', password: 'another one' } });
    expect(dup.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/web/signup', payload: { email: 'x@example.com', password: 'short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/web/signup', payload: { email: 'nope', password: 'long enough' } })).statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: '/web/signin', payload: { email: 'sam@example.com', password: 'wrong password' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/web/signin', payload: { email: 'who@example.com', password: 'correct horse' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/web/signin', payload: { email: ' Sam@Example.com ', password: 'correct horse' } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/alerts', headers: { cookie } })).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/web/signout', headers: { cookie } });
    expect(out.statusCode).toBe(303);
    expect((await app.inject({ url: '/alerts', headers: { cookie } })).statusCode).toBe(302);

    // A cross-site post is refused before it reaches the handler.
    const cross = await app.inject({ method: 'POST', url: '/web/signin', headers: { origin: 'https://evil.example' }, payload: { email: 'sam@example.com', password: 'correct horse' } });
    expect(cross.statusCode).toBe(403);
  });

  it('saves a search as an alert, shows new matches once, and emails a digest', async () => {
    const cookie = await cookieFor('lee@example.com');
    expect((await app.inject({ method: 'POST', url: '/web/alerts', payload: { pay300: true } })).statusCode).toBe(401);
    const saved = await app.inject({ method: 'POST', url: '/web/alerts', headers: { cookie }, payload: { query: 'engineer', pay300: true } });
    expect(saved.statusCode).toBe(201);
    const id = saved.json().id;

    // Two postings appear after the alert was saved; only the one paying $300k+ matches.
    const added = (j: JobItem) =>
      db.query(`INSERT INTO changes (resource_id, type, item_key, summary, data, search_text) VALUES ($1, 'JOB_ADDED', $2, $3, $4, $5)`, [
        board,
        j.key,
        `New job: ${j.title}`,
        JSON.stringify({ job: j }),
        `${j.title} ${j.location} ${j.company}`.toLowerCase(),
      ]);
    await added(job('n1', 'Staff Platform Engineer', 360_000));
    await added(job('n2', 'Junior Engineer', 120_000));

    const page = await app.inject({ url: '/alerts', headers: { cookie } });
    expect(page.body).toContain('engineer · $300k+');
    expect(page.body).toContain('1 new');

    const sent: Email[] = [];
    expect(await sendDueDigests(ctx, async (_c, e) => void sent.push(e))).toBe(1);
    expect(sent[0]).toMatchObject({ to: 'lee@example.com', subject: '1 new job: Staff Platform Engineer' });
    expect(sent[0]!.html).toContain('$300k–360k');
    // Not again the same day, and not for the same jobs.
    expect(await sendDueDigests(ctx, async (_c, e) => void sent.push(e))).toBe(0);
    await db.query("UPDATE users SET last_alert_at = now() - interval '2 days'");
    expect(await sendDueDigests(ctx, async (_c, e) => void sent.push(e))).toBe(0);

    const fresh = await app.inject({ method: 'POST', url: `/web/alerts/${id}/new`, headers: { cookie } });
    expect(fresh.json().jobs.map((j: JobItem) => j.title)).toEqual(['Staff Platform Engineer']);
    expect((await app.inject({ method: 'POST', url: `/web/alerts/${id}/new`, headers: { cookie } })).json().jobs).toEqual([]);

    // Someone else's alert is not reachable.
    const other = await cookieFor('kim@example.com');
    expect((await app.inject({ method: 'POST', url: `/web/alerts/${id}/delete`, headers: { cookie: other } })).statusCode).toBe(404);

    expect((await app.inject({ method: 'POST', url: '/web/account/email', headers: { cookie }, payload: { on: false } })).json()).toEqual({ ok: true, email_alerts: false });
    expect((await app.inject({ method: 'POST', url: `/web/alerts/${id}/delete`, headers: { cookie } })).statusCode).toBe(200);
  });

  it('deletes an account with its saved searches', async () => {
    const cookie = await cookieFor('del@example.com');
    await app.inject({ method: 'POST', url: '/web/alerts', headers: { cookie }, payload: { pay300: true } });
    expect((await app.inject({ method: 'POST', url: '/web/account/delete', headers: { cookie } })).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM watches')).rows[0].n).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/web/signin', payload: { email: 'del@example.com', password: 'correct horse' } })).statusCode).toBe(401);
  });
});

describe('website helpers', () => {
  it('hashes passwords with a salt', async () => {
    const a = await hashPassword('hunter22');
    expect(a).not.toBe(await hashPassword('hunter22'));
    expect(await verifyPassword('hunter22', a)).toBe(true);
    expect(await verifyPassword('hunter23', a)).toBe(false);
  });

  it('keeps ?next= on this site', () => {
    expect(safeNext('/jobs?q=ios&pay=1')).toBe('/jobs?q=ios&pay=1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/a"><script>', 42]) expect(safeNext(bad)).toBe('/jobs');
  });

  it('reads cookies', () => {
    expect(readCookie('a=1; wt_session=abc%2D; b=2', 'wt_session')).toBe('abc-');
    expect(readCookie(undefined, 'wt_session')).toBeUndefined();
  });
});
