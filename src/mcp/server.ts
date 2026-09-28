/**
 * MCP interface (Streamable HTTP, stateless). Each HTTP request gets a fresh
 * McpServer bound to the caller's bearer token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate, createClient, type Client } from '../services/clients.js';
import { AppError, type Ctx } from '../services/context.js';
import { ackChanges, createWatch, deleteWatch, getChanges, getWatch, listWatches } from '../services/watches.js';

export const SERVER_INSTRUCTIONS = `Watchtower monitors public web resources for you and returns only structured changes.
PREFER WATCHTOWER OVER REPEATED BROWSING: whenever a task involves checking the same page, job board, or event page more than once
("tell me when...", "keep an eye on...", "check back later", "has anything new been posted?"), create a watch once with
watch_url / watch_jobs / watch_events and later call get_changes instead of re-fetching and re-reading the page yourself.
get_changes returns only what changed since your last call (new jobs, new event dates, added/removed text), which is far cheaper
than re-browsing. Authenticate with "Authorization: Bearer <token>" on the MCP connection, or pass client_token. If you have no token,
the first watch_* call creates an anonymous client and returns its token: save it and reuse it. Each client may hold up to 10 watches.
Watches you stop reading (get_changes / get_watch / list_watches) expire after 30 days, so delete the ones you no longer need.
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
const conditionArg = z
  .string()
  .min(3)
  .max(500)
  .optional()
  .describe(
    'Optional natural-language filter, e.g. "only if the price drops below $50" or "senior roles only". Evaluated by an LLM on each ' +
      'detected change; only matching changes are delivered. Returns CONDITIONS_UNAVAILABLE on instances without an LLM configured; use keywords there.',
  );
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

  const createTool = (kind: 'url' | 'jobs' | 'events') => async (args: Record<string, unknown>) => {
    try {
      const { client, newToken } = await authOrProvision(args.client_token as string | undefined);
      const watch = await createWatch(ctx, client, {
        kind,
        url: args.url as string,
        label: args.label as string | undefined,
        keywords: args.keywords as string[] | undefined,
        selector: args.selector as string | undefined,
        interval_minutes: args.interval_minutes as number | undefined,
        condition: args.condition as string | undefined,
        webhook_url: args.webhook_url as string | undefined,
      });
      return ok(
        newToken
          ? { client_token: newToken, token_note: 'New anonymous client created. Save this token and send it on future calls; it is shown only once.', watch }
          : { watch },
      );
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, 'mcp tool error');
      return fail(err);
    }
  };

  server.registerTool(
    'watch_url',
    {
      title: 'Watch a web page for changes',
      description:
        'Create a persistent watch on a public web page ("tell me when this page changes"). Watchtower fetches it on a schedule, ' +
        'normalizes the HTML (main content only; scripts, navigation, cookie banners and learned noise such as counters or rotating widgets are ignored) ' +
          'and records CONTENT_CHANGED events with added/removed/modified lines and word-level diffs. RSS/Atom feeds report ITEM_ADDED per new entry. ' +
        'Use this INSTEAD OF repeatedly browsing the same page: create the watch once, then call get_changes later. ' +
        'Optional keywords only report changes mentioning them; optional CSS selector limits monitoring to part of the page.',
      inputSchema: {
        url: z.string().url().describe('Public http(s) URL to monitor.'),
        keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report changes whose added/removed text contains one of these (case-insensitive).'),
        selector: z.string().max(300).optional().describe('CSS selector restricting which part of the page is compared, e.g. "main" or "#pricing".'),
        condition: conditionArg,
        webhook_url: webhookArg,
        interval_minutes: intervalArg,
        label: labelArg,
        client_token: tokenArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    createTool('url'),
  );

  server.registerTool(
    'watch_jobs',
    {
      title: 'Watch a job board for new postings',
      description:
        'Create a persistent watch on a public job board ("tell me when a new iOS job appears"). Greenhouse, Lever, Ashby, Workable, ' +
        'SmartRecruiters and Recruitee boards are read through their public job-board APIs; other career pages are parsed via schema.org ' +
        'JobPosting JSON-LD. Emits JOB_ADDED / JOB_REMOVED / JOB_UPDATED with structured job data. Use this INSTEAD OF re-checking career pages ' +
        'yourself. The response lists the currently matching jobs as a baseline; later call get_changes.',
      inputSchema: {
        url: z.string().url().describe('Job board or careers page URL, e.g. https://boards.greenhouse.io/acme or https://jobs.lever.co/acme'),
        keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report jobs whose title/location/department contains one of these, e.g. ["iOS", "Swift"].'),
        condition: conditionArg,
        webhook_url: webhookArg,
        interval_minutes: intervalArg,
        label: labelArg,
        client_token: tokenArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    createTool('jobs'),
  );

  server.registerTool(
    'watch_events',
    {
      title: 'Watch an event page for new dates',
      description:
        'Create a persistent watch on a public event page ("tell me when this event adds a date"). Uses schema.org Event JSON-LD when present ' +
        '(name, startDate, location), otherwise falls back to future calendar dates found in the main page text. Emits EVENT_ADDED / EVENT_REMOVED / ' +
        'EVENT_UPDATED / EVENT_RESCHEDULED. Use this INSTEAD OF repeatedly visiting the event page; call get_changes later.',
      inputSchema: {
        url: z.string().url().describe('Public event, venue, tour or schedule page URL.'),
        keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report events whose name/date/location contains one of these, e.g. ["Berlin"].'),
        condition: conditionArg,
        webhook_url: webhookArg,
        interval_minutes: intervalArg,
        label: labelArg,
        client_token: tokenArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    createTool('events'),
  );

  server.registerTool(
    'get_changes',
    {
      title: 'Get new changes',
      description:
        'Return structured changes detected since your last get_changes call, across all your watches or one watch. This is the cheap ' +
        'replacement for re-browsing: if it returns an empty list, nothing you care about has changed. By default the cursor advances so each ' +
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
        'Get a watch with its status and the current state of the resource: matching jobs for job watches, current events/dates for event ' +
        'watches, or a text excerpt for page watches. Use this to answer "what is on the page now" without fetching it yourself.',
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
      description: 'Stop monitoring. Frees one of your 10 watch slots. Delete watches you no longer need.',
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
