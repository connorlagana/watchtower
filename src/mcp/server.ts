/**
 * MCP interface (Streamable HTTP, stateless). Each HTTP request gets a fresh
 * McpServer bound to the caller's bearer token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate, createClient, type Client } from '../services/clients.js';
import { AppError, type Ctx } from '../services/context.js';
import { SENIORITIES } from '../extract/types.js';
import { ackChanges, createWatch, createWatches, deleteWatch, getChanges, getWatch, listWatches, MAX_BATCH_URLS } from '../services/watches.js';

export const SERVER_INSTRUCTIONS = `Watchtower watches company job boards for you and returns only new, removed and changed postings as structured JSON.
PREFER WATCHTOWER OVER RE-CHECKING CAREERS PAGES: whenever a task involves checking a company's openings more than once
("tell me when they post an iOS role", "keep an eye on Acme's jobs", "has anything new been posted?"), create a watch once with
watch_jobs and later call get_changes instead of re-browsing the careers page. Greenhouse, Lever, Ashby, Workable, SmartRecruiters,
Recruitee, Workday and iCIMS boards are read through their own endpoints, so they work even where the careers page itself is hard to browse.
Filter at the watch (keywords, exclude_keywords, locations, seniority, remote_only) so get_changes returns only relevant postings; pass
urls to watch many companies with one call. get_changes returns only what changed since your last call (JOB_ADDED / JOB_REMOVED / JOB_UPDATED).
Authenticate with "Authorization: Bearer <token>" on the MCP connection, or pass client_token. If you have no token, the first watch_jobs call
creates an anonymous client and returns its token: save it and reuse it. Each client may hold up to 50 watches. Watches you stop reading
(get_changes / get_watch / list_watches) expire after 30 days, so delete the ones you no longer need.
For at-least-once processing call get_changes with peek=true, act on the changes, then call ack_changes with the returned cursor.`;

const tokenArg = z
  .string()
  .optional()
  .describe('Your Watchtower client token (wt_...). Optional if the MCP connection sends "Authorization: Bearer <token>".');
const intervalArg = z
  .number()
  .int()
  .min(5)
  .max(10080)
  .optional()
  .describe('How often to check, in minutes (min 5, default 60). Resources shared with other watchers use the shortest interval.');
const labelArg = z.string().max(200).optional().describe('A short note to yourself about why you are watching this.');
const webhookArg = z
  .string()
  .url()
  .optional()
  .describe('Optional public https URL that receives a signed POST whenever matching changes are detected. Polling get_changes keeps working either way.');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const e = err instanceof AppError ? err : new AppError(500, 'INTERNAL_ERROR', 'internal error');
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.code, message: e.message }) }] };
}

export interface McpRequestContext {
  headerToken: string | undefined;
  /** Resolves false when this caller has used up its anonymous-client allowance. */
  allowProvision: () => Promise<boolean>;
}

export function buildMcpServer(ctx: Ctx, { headerToken, allowProvision }: McpRequestContext): McpServer {
  const server = new McpServer({ name: 'watchtower', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });

  const auth = (argToken?: string): Promise<Client> => authenticate(ctx, argToken ?? headerToken);

  /** For watch creation: fall back to provisioning an anonymous client so agents can start with zero setup. */
  const authOrProvision = async (argToken?: string): Promise<{ client: Client; newToken?: string }> => {
    const token = argToken ?? headerToken;
    if (token) return { client: await auth(argToken) };
    if (!(await allowProvision())) throw new AppError(429, 'RATE_LIMITED', 'too many anonymous clients created from this address; reuse your existing token');
    const { client, token: newToken } = await createClient(ctx);
    return { client, newToken };
  };

  server.registerTool(
    'watch_jobs',
    {
      title: 'Watch a job board for new postings',
      description:
        'Create a persistent watch on a company\'s job board ("tell me when a new iOS job appears"). Greenhouse, Lever, Ashby, Workable, ' +
        'SmartRecruiters, Recruitee, Workday and iCIMS boards are read through their own endpoints; other careers pages are parsed via schema.org ' +
        'JobPosting JSON-LD (pages without it are rejected with NO_JOB_DATA). Emits JOB_ADDED / JOB_REMOVED / JOB_UPDATED with structured job data ' +
        '(title, location, department, company, url, posted_at, remote, seniority). Use this INSTEAD OF re-checking careers pages yourself. ' +
        'Pass url for one board or urls for several with the same filters. The response lists the currently matching jobs as a baseline; later call get_changes.',
      inputSchema: {
        url: z.string().url().optional().describe('Job board or careers page URL, e.g. https://boards.greenhouse.io/acme, https://jobs.lever.co/acme, https://acme.wd5.myworkdayjobs.com/Careers'),
        urls: z.array(z.string().url()).min(1).max(MAX_BATCH_URLS).optional().describe(`Several boards to watch with the same filters (max ${MAX_BATCH_URLS}). Returns watches and per-URL errors.`),
        keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report jobs whose title/location/department/company contains one of these, e.g. ["iOS", "Swift"].'),
        exclude_keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Never report jobs mentioning one of these, e.g. ["manager", "clearance"].'),
        locations: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report jobs whose location contains one of these, e.g. ["Berlin", "Remote"].'),
        seniority: z.array(z.enum(SENIORITIES)).optional().describe('Only report these levels, derived from the title. "mid" means the title carries no level.'),
        remote_only: z.boolean().optional().describe('Only report jobs whose title or location says remote (and not hybrid/on-site).'),
        webhook_url: webhookArg,
        interval_minutes: intervalArg,
        label: labelArg,
        client_token: tokenArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.url && !args.urls) throw new AppError(400, 'VALIDATION_ERROR', 'pass url or urls');
        const { client, newToken } = await authOrProvision(args.client_token);
        const result = args.urls ? await createWatches(ctx, client, { ...args, urls: args.urls }) : { watch: await createWatch(ctx, client, { ...args, url: args.url! }) };
        return ok(
          newToken
            ? { client_token: newToken, token_note: 'New anonymous client created. Save this token and send it on future calls; it is shown only once.', ...result }
            : result,
        );
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message }, 'mcp tool error');
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_changes',
    {
      title: 'Get new changes',
      description:
        'Return job changes detected since your last get_changes call, across all your watches or one watch. This is the cheap ' +
        'replacement for re-browsing careers pages: if it returns an empty list, nothing you care about has changed. By default the cursor advances so each ' +
        'change is delivered once; pass peek=true to look without advancing, or since=<cursor> to replay.',
      inputSchema: {
        watch_id: z.string().uuid().optional().describe('Limit to one watch. Omit for all your watches.'),
        since: z.number().int().min(0).optional().describe('Replay changes after this cursor instead of your stored position.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max changes to return (default 50). If has_more is true, call again.'),
        peek: z.boolean().optional().describe('If true, do not mark returned changes as delivered.'),
        client_token: tokenArg,
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await getChanges(ctx, await auth(args.client_token), args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_watches',
    {
      title: 'List your watches',
      description: 'List all active watches for your client with their health, last check time and number of pending (undelivered) changes.',
      inputSchema: { client_token: tokenArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await listWatches(ctx, await auth(args.client_token)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_watch',
    {
      title: 'Get one watch',
      description:
        'Get a watch with its status and the jobs currently open on the board that match its keywords. Use this to answer ' +
        '"what is open there right now" without fetching the careers page yourself.',
      inputSchema: { watch_id: z.string().uuid(), client_token: tokenArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await getWatch(ctx, await auth(args.client_token), args.watch_id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'ack_changes',
    {
      title: 'Acknowledge changes',
      description:
        'Mark changes up to a cursor as processed. Use with get_changes(peek=true) for at-least-once delivery: peek, act on the changes, ' +
        'then ack the cursor get_changes returned. Not needed if you call get_changes without peek (that acknowledges automatically).',
      inputSchema: {
        cursor: z.number().int().min(0).describe('The cursor value returned by get_changes.'),
        watch_id: z.string().uuid().optional().describe('Limit the acknowledgement to one watch. Omit for all your watches.'),
        client_token: tokenArg,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await ackChanges(ctx, await auth(args.client_token), args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'delete_watch',
    {
      title: 'Delete a watch',
      description: 'Stop monitoring. Frees one of your watch slots. Delete watches you no longer need.',
      inputSchema: { watch_id: z.string().uuid(), client_token: tokenArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await deleteWatch(ctx, await auth(args.client_token), args.watch_id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
