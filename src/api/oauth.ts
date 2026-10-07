/**
 * OAuth 2.1 for MCP connections (the MCP authorization spec): protected-resource
 * and authorization-server metadata, dynamic client registration, an
 * authorization endpoint with PKCE and a token endpoint.
 *
 * There are no accounts. Authorizing either creates a new anonymous client or,
 * when the user pastes an existing token, connects that client. Either way the
 * app receives a bearer token for the connection, so the token never has to
 * pass through a chat or a tool argument.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { authenticate, createClient, hashToken, issueToken } from '../services/clients.js';
import type { Ctx } from '../services/context.js';
import { clientBucket, hit, type LimitSpec } from '../services/rateLimit.js';
import { authorizeErrorPage, authorizePage } from '../web/site.js';

const CODE_TTL_SECONDS = 300;
export const OAUTH_SCOPE = 'watches';

export const resourceMetadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource/mcp`;

/** The WWW-Authenticate challenge that points an MCP client at the OAuth flow. */
export const authChallenge = (base: string, description: string) =>
  `Bearer resource_metadata="${resourceMetadataUrl(base)}", scope="${OAUTH_SCOPE}", error="invalid_token", error_description="${description.replace(/["\\]/g, '')}"`;

/** https anywhere, or http on a loopback host (native apps, RFC 8252). No fragments. */
function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface OAuthClient {
  id: string;
  client_name: string | null;
  redirect_uris: string[];
}

/** The fields of an authorization request, as received on GET and carried through the consent form. */
const AUTHORIZE_FIELDS = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'] as const;
type AuthorizeFields = Partial<Record<(typeof AUTHORIZE_FIELDS)[number], string>>;

export async function registerOAuthRoutes(app: FastifyInstance, ctx: Ctx, opts: { clientCreationPerHour: number }): Promise<void> {
  const base = ctx.config.publicBaseUrl;
  const db = ctx.db;

  // OAuth token and consent requests are form-encoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Browser-based MCP clients read the metadata and call register/token cross-origin.
  const cors = (reply: FastifyReply) =>
    reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version');
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token']) {
    app.options(path, { config: { limit: false } }, async (_req, reply) => cors(reply).header('access-control-allow-methods', 'GET, POST, OPTIONS').code(204).send());
  }

  const resourceMetadata = {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Watchtower',
    resource_documentation: `${base}/docs`,
  };
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => cors(reply).send(resourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', async (_req, reply) => cors(reply).send(resourceMetadata));
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    cors(reply).send({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: [OAUTH_SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: `${base}/docs`,
    }),
  );

  // --- dynamic client registration (RFC 7591); public clients only ----------
  const registerLimit: LimitSpec = { name: 'oauth_register', max: 30, windowSeconds: 3600 };
  app.post('/oauth/register', { config: { limit: registerLimit } }, async (req, reply) => {
    cors(reply).header('cache-control', 'no-store');
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be 1-10 https URLs (or http on localhost) without fragments' });
    }
    const name = typeof body.client_name === 'string' ? body.client_name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) || null : null;
    const id = `wtc_${randomBytes(16).toString('base64url')}`;
    await db.query('INSERT INTO oauth_clients (id, client_name, redirect_uris) VALUES ($1, $2, $3)', [id, name, uris]);
    return reply.code(201).send({
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name ?? undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // --- authorization endpoint ----------------------------------------------
  /**
   * Checks an authorization request. Problems with client_id or redirect_uri are shown on a page (the app cannot be
   * trusted to receive them); everything else is sent back to the app's redirect_uri as an OAuth error.
   */
  async function checkRequest(f: AuthorizeFields): Promise<{ page: string } | { redirect: string } | { client: OAuthClient; redirectUri: string }> {
    const { rows } = f.client_id ? await db.query<OAuthClient>('SELECT id, client_name, redirect_uris FROM oauth_clients WHERE id = $1', [f.client_id]) : { rows: [] };
    const client = rows[0];
    if (!client) return { page: 'This app is not registered with Watchtower. Remove the connection and add it again.' };
    const redirectUri = f.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return { page: 'The redirect address does not match the one this app registered.' };
    const back = (error: string, description: string) => ({ redirect: withParams(redirectUri, { error, error_description: description, state: f.state, iss: base }) });
    if (f.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (!f.code_challenge || f.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(f.code_challenge)) {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    if (f.scope && !f.scope.split(' ').every((s) => s === OAUTH_SCOPE || s === '')) return back('invalid_scope', `the only scope is "${OAUTH_SCOPE}"`);
    return { client, redirectUri };
  }

  const fieldsOf = (src: unknown): AuthorizeFields => {
    const o = (src ?? {}) as Record<string, unknown>;
    return Object.fromEntries(AUTHORIZE_FIELDS.filter((k) => typeof o[k] === 'string').map((k) => [k, (o[k] as string).slice(0, 2000)]));
  };

  const sendPage = (reply: FastifyReply, status: number, html: string) =>
    reply
      .code(status)
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "frame-ancestors 'none'")
      .type('text/html; charset=utf-8')
      .send(html);

  const consent = (reply: FastifyReply, client: OAuthClient, redirectUri: string, f: AuthorizeFields, error?: string) =>
    sendPage(
      reply,
      error ? 400 : 200,
      authorizePage({
        clientName: client.client_name ?? 'An MCP app',
        redirectHost: new URL(redirectUri).host,
        fields: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Record<string, string>,
        error,
      }),
    );

  app.get('/oauth/authorize', async (req, reply) => {
    const f = fieldsOf(req.query);
    const r = await checkRequest(f);
    if ('page' in r) return sendPage(reply, 400, authorizeErrorPage(r.page));
    if ('redirect' in r) return reply.redirect(r.redirect);
    return consent(reply, r.client, r.redirectUri, f);
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const f = fieldsOf(body);
    const r = await checkRequest(f);
    if ('page' in r) return sendPage(reply, 400, authorizeErrorPage(r.page));
    if ('redirect' in r) return reply.redirect(r.redirect);

    let clientId: string;
    if (body.action === 'existing') {
      try {
        clientId = (await authenticate(ctx, typeof body.token === 'string' ? body.token.trim() : undefined)).id;
      } catch {
        return consent(reply, r.client, r.redirectUri, f, 'That token is not a valid Watchtower token.');
      }
    } else {
      // New clients draw on the same per-address budget as POST /v1/clients.
      const allowed = (await hit(db, clientBucket(req.ip), { name: 'client_creation', max: opts.clientCreationPerHour, windowSeconds: 3600 })).allowed;
      if (!allowed) return consent(reply, r.client, r.redirectUri, f, 'Too many clients were created from your network recently. Try again later, or paste an existing token.');
      clientId = (await createClient(ctx, { source: 'oauth', userAgent: r.client.client_name })).client.id;
    }

    const code = randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO oauth_codes (code_hash, oauth_client_id, client_id, redirect_uri, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [hashToken(code), r.client.id, clientId, r.redirectUri, f.code_challenge, CODE_TTL_SECONDS],
    );
    return reply.redirect(withParams(r.redirectUri, { code, state: f.state, iss: base }), 303);
  });

  // --- token endpoint --------------------------------------------------------
  const tokenLimit: LimitSpec = { name: 'oauth_token', max: 60, windowSeconds: 60 };
  app.post('/oauth/token', { config: { limit: tokenLimit } }, async (req, reply) => {
    cors(reply).header('cache-control', 'no-store').header('pragma', 'no-cache');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
    const fail = (error: string, description: string) => reply.code(400).send({ error, error_description: description });

    if (str('grant_type') !== 'authorization_code') return fail('unsupported_grant_type', 'only authorization_code is supported');
    const code = str('code');
    const verifier = str('code_verifier');
    const clientId = str('client_id');
    if (!code || !verifier || !clientId) return fail('invalid_request', 'code, code_verifier and client_id are required');

    // Single use: the code is gone after this, whether or not the rest checks out.
    const { rows } = await db.query<{ oauth_client_id: string; client_id: string; redirect_uri: string; code_challenge: string; expired: boolean }>(
      'DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING oauth_client_id, client_id, redirect_uri, code_challenge, expires_at < now() AS expired',
      [hashToken(code)],
    );
    const grant = rows[0];
    if (!grant || grant.expired) return fail('invalid_grant', 'unknown or expired code');
    if (grant.oauth_client_id !== clientId) return fail('invalid_grant', 'code was issued to another client');
    const redirectUri = str('redirect_uri');
    if (redirectUri !== undefined && redirectUri !== grant.redirect_uri) return fail('invalid_grant', 'redirect_uri does not match');
    if (!sameString(s256(verifier), grant.code_challenge)) return fail('invalid_grant', 'code_verifier does not match code_challenge');

    const token = await issueToken(ctx, grant.client_id, clientId);
    return reply.send({ access_token: token, token_type: 'Bearer', scope: OAUTH_SCOPE });
  });
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
