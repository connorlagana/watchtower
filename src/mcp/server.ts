/**
 * MCP interface (Streamable HTTP, stateless). Each HTTP request gets a fresh
 * McpServer bound to the caller's bearer token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authenticate, createClient, type Client } from '../services/clients.js';
import { AppError, type Ctx } from '../services/context.js';
import { SENIORITIES } from '../extract/types.js';
import { ackChanges, createSearchWatch, createWatch, createWatches, deleteWatch, getChanges, getWatch, listWatches, MAX_BATCH_URLS } from '../services/watches.js';

export const SERVER_INSTRUCTIONS = `Watchtower watches tech job boards for you and returns only new, removed and changed postings as structured JSON.
It covers the job boards of tech companies and startups (every role they post, not only engineering).
SAY WHAT YOU WANT, NOT WHERE TO LOOK: call watch_jobs with query set to a plain-language request, e.g.
"iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience". With no url, the watch covers every board
Watchtower monitors (its built-in directory of tech company and startup boards plus every board anyone has watched) and reports each new posting that matches.
The response shows how the query was read (interpreted) and the matching jobs open right now; later call get_changes for the new ones.
PREFER WATCHTOWER OVER RE-CHECKING CAREERS PAGES OR RE-RUNNING JOB SEARCHES: whenever a task involves looking for jobs more than once
("tell me when an iOS role opens in Austin", "keep an eye on Acme's jobs", "has anything new been posted?"), create a watch once and
later call get_changes. To follow one company, or to add a company the directory is missing, pass its board url or careers page (or urls for several):
Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Workday and iCIMS boards are read through their own endpoints.
Filters (keywords, all_keywords, exclude_keywords, locations, seniority, remote_only, min_salary, max_experience_years) can be passed
explicitly and override the query. Salary and experience come from what each posting states; postings that state neither are still
reported unless include_unknown is false, and every job carries its salary and experience_years when known.
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
      title: 'Watch for new job postings',
      description:
        'Create a persistent watch for tech jobs. Describe what you want in query ("iOS jobs in Austin making at least 150k a year with a maximum of ' +
        '6 years of experience") and leave url out: the watch then covers every job board Watchtower monitors (tech companies and startups, whatever platform they use) and reports ' +
        'each new matching posting (JOB_ADDED). The response shows how the query was read (interpreted), the jobs open right now that match ' +
        '(current_jobs) and how many boards are covered (coverage); later call get_changes for new ones. Use this INSTEAD OF re-running job searches ' +
        'or re-checking careers pages yourself. ' +
        'To follow one company, or to cover a company the directory is missing, pass url (or urls for several): Greenhouse, Lever, Ashby, Workable, ' +
        'SmartRecruiters, Recruitee, Workday and iCIMS boards are read through their own endpoints; other careers pages are parsed via schema.org ' +
        'JobPosting JSON-LD. A careers page that only links to a supported board is watched through that board (resolved_from says so); a page with neither is rejected with NO_JOB_DATA. A board you watch stays covered for every search watch. A board watch emits JOB_ADDED / JOB_REMOVED / JOB_UPDATED. ' +
        'Jobs carry title, location, other_locations, department, company, url, posted_at, remote, seniority, and salary / experience_years when the posting states them. ' +
        'Explicit filters override what the query says.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            'What to watch for, in plain language: role, place, pay, experience, level, remote. E.g. "iOS jobs in Austin making at least 150k a year with a maximum of 6 years of experience", ' +
              '"senior backend roles in New York or remote paying $180k+". Check interpreted in the response.',
          ),
        url: z.string().url().optional().describe('Optional. Limit the watch to one job board or careers page, e.g. https://boards.greenhouse.io/acme, https://jobs.lever.co/acme, https://acme.wd5.myworkdayjobs.com/Careers. Omit to watch every monitored board.'),
        urls: z.array(z.string().url()).min(1).max(MAX_BATCH_URLS).optional().describe(`Optional. Several boards to watch with the same filters (max ${MAX_BATCH_URLS}). Returns watches and per-URL errors.`),
        keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report jobs whose title/location/department/company contains one of these as a whole word, e.g. ["iOS", "Swift"].'),
        all_keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report jobs containing every one of these, e.g. ["data", "scientist"].'),
        exclude_keywords: z.array(z.string().min(1).max(100)).max(20).optional().describe('Never report jobs mentioning one of these, e.g. ["manager", "clearance"].'),
        locations: z.array(z.string().min(1).max(100)).max(20).optional().describe('Only report jobs with one of these in their location, e.g. ["Austin"], ["Berlin", "Remote"].'),
        seniority: z.array(z.enum(SENIORITIES)).optional().describe('Only report these levels, derived from the title. "mid" means the title carries no level.'),
        remote_only: z.boolean().optional().describe('Only report jobs whose title or location says remote (and not hybrid/on-site).'),
        min_salary: z.number().min(0).max(100_000_000).optional().describe('Yearly pay the job must be able to reach, e.g. 150000. Compared with the top of the posted range (hourly and monthly pay are converted).'),
        salary_currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('ISO currency of min_salary, e.g. "USD". Jobs that state pay in another currency are then left out.'),
        max_experience_years: z.number().min(0).max(60).optional().describe('The most years of experience a job may ask for, e.g. 6.'),
        include_unknown: z
          .boolean()
          .optional()
          .describe('Many postings state no pay or no years of experience. true (default) still reports them, without a salary / experience_years field; false reports only postings that state a qualifying value.'),
        webhook_url: webhookArg,
        interval_minutes: intervalArg,
        label: labelArg,
        client_token: tokenArg,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.url && args.urls) throw new AppError(400, 'VALIDATION_ERROR', 'pass url or urls, not both');
        const { client, newToken } = await authOrProvision(args.client_token);
        const result = args.urls
          ? await createWatches(ctx, client, { ...args, urls: args.urls })
          : { watch: args.url ? await createWatch(ctx, client, { ...args, url: args.url }) : await createSearchWatch(ctx, client, args) };
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
        'Get a watch with its status and the jobs currently open that match its filters: on its board, or across every monitored board for a ' +
        'watch created without a url. Use this to answer "what is open right now" without searching or fetching careers pages yourself.',
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
