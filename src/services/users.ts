/**
 * Website accounts: email + password, a session cookie, and a Watchtower client behind each person so their saved
 * searches are ordinary search watches.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createClient, hashToken, type Client } from './clients.js';
import { AppError, type Ctx } from './context.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export interface User {
  id: string;
  email: string;
  client_id: string | null;
  email_alerts: boolean;
  created_at: Date;
}

export const SESSION_COOKIE = 'wt_session';
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 8;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(got, expected);
}

/** A stored hash of a random password, compared against when the email is unknown so both paths take as long. */
let decoy: Promise<string> | null = null;

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!EMAIL.test(e) || e.length > 254) throw new AppError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  return e;
}

export async function signUp(ctx: Ctx, input: { email: string; password: string; source?: string | null; userAgent?: string | null }): Promise<User> {
  const email = normalizeEmail(input.email);
  if (input.password.length < MIN_PASSWORD) throw new AppError(400, 'WEAK_PASSWORD', `Use at least ${MIN_PASSWORD} characters.`);
  if (input.password.length > 200) throw new AppError(400, 'WEAK_PASSWORD', 'That password is too long.');
  const passwordHash = await hashPassword(input.password);
  const { client } = await createClient(ctx, { source: input.source ?? 'web', userAgent: input.userAgent ?? null });
  try {
    const { rows } = await ctx.db.query<User>(
      `INSERT INTO users (email, password_hash, client_id) VALUES ($1, $2, $3)
       RETURNING id, email, client_id, email_alerts, created_at`,
      [email, passwordHash, client.id],
    );
    return rows[0]!;
  } catch (err) {
    await ctx.db.query('DELETE FROM clients WHERE id = $1', [client.id]);
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'An account with that email already exists. Sign in instead.');
    throw err;
  }
}

export async function signIn(ctx: Ctx, input: { email: string; password: string }): Promise<User> {
  const fail = new AppError(401, 'BAD_CREDENTIALS', 'That email and password do not match.');
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    throw fail;
  }
  const { rows } = await ctx.db.query<User & { password_hash: string }>(
    'SELECT id, email, client_id, email_alerts, created_at, password_hash FROM users WHERE lower(email) = $1',
    [email],
  );
  const row = rows[0];
  if (!row) {
    await verifyPassword(input.password, await (decoy ??= hashPassword(randomBytes(12).toString('hex'))));
    throw fail;
  }
  if (!(await verifyPassword(input.password, row.password_hash))) throw fail;
  const { password_hash: _ph, ...user } = row;
  return user;
}

export async function createSession(ctx: Ctx, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await ctx.db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS],
  );
  return token;
}

export async function endSession(ctx: Ctx, token: string | undefined): Promise<void> {
  if (token) await ctx.db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** The signed-in user for a session cookie value, or null. Touches last_seen at most once an hour. */
export async function sessionUser(ctx: Ctx, token: string | undefined): Promise<User | null> {
  if (!token || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const { rows } = await ctx.db.query<User>(
    `SELECT u.id, u.email, u.client_id, u.email_alerts, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const user = rows[0] ?? null;
  if (user) await ctx.db.query("UPDATE users SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 hour'", [user.id]);
  return user;
}

/** The person's Watchtower client, created again if maintenance removed an idle one. */
export async function userClient(ctx: Ctx, user: User): Promise<Client> {
  if (user.client_id) {
    const { rows } = await ctx.db.query<Client>('SELECT id, created_at FROM clients WHERE id = $1', [user.client_id]);
    if (rows[0]) {
      await ctx.db.query("UPDATE clients SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 hour'", [rows[0].id]);
      return rows[0];
    }
  }
  const { client } = await createClient(ctx, { source: 'web' });
  await ctx.db.query('UPDATE users SET client_id = $2 WHERE id = $1', [user.id, client.id]);
  user.client_id = client.id;
  return client;
}

export async function setEmailAlerts(ctx: Ctx, user: User, on: boolean): Promise<void> {
  await ctx.db.query('UPDATE users SET email_alerts = $2 WHERE id = $1', [user.id, on]);
}

export async function deleteUser(ctx: Ctx, user: User): Promise<void> {
  await ctx.db.query('DELETE FROM users WHERE id = $1', [user.id]);
  if (user.client_id) await ctx.db.query('DELETE FROM clients WHERE id = $1', [user.client_id]);
}
