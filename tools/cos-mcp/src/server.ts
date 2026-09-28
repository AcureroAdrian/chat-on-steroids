import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CosEnv } from './env.js';
import { gatherHealth } from './health.js';
import { control } from './lifecycle.js';
import { queryLog, readLog } from './log.js';
import { Store } from './store.js';

export const VERSION = '0.1.0';

const INSTRUCTIONS = `
cos-mcp watches and controls the local Chat On Steroids desktop app from outside its process,
so it keeps working when the app is hung or dead. You are the watcher: decide when to check and
what to do; these tools report facts and enforce a few safety limits.

- Start with cos_health. It returns a state, the evidence behind it and a suggestedAction:
  healthy, degraded (answers but reports problems), not_responding, starting, startup_hung,
  updating, stopped_by_user, down.
- Follow suggestedAction unless you have a reason not to. Never restart during "updating".
  "stopped_by_user" means the user closed the app on purpose: only start it if they ask.
- "degraded" issues (failed disk writes, outdated browser extension, offline tunnel, unattributed
  calls, failing workers) are not fixed by a restart. Report them to the user.
- cos_restart re-checks a silent app for up to 45 s before killing it, saves evidence first, and
  refuses after 3 automatic restarts in an hour. Always give a concrete reason; it is journaled.
- cos_logs reads the app's own log; cos_journal lists what this server did before.
`.trim();

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const controlInput = z.object({
  reason: z.string().min(3).max(500).describe('Why this is being done. Journaled and shown to the user.'),
  userRequested: z
    .boolean()
    .default(false)
    .describe('True only when the user explicitly asked for this action in the conversation.'),
  force: z
    .boolean()
    .default(false)
    .describe('Override a safety refusal (killing an app that still answers, or the hourly restart limit). Use only with a strong reason.')
});

export function createServer(env: CosEnv, options: { readOnly: boolean }): McpServer {
  const store = new Store(env.homeDir);
  const server = new McpServer({ name: 'cos-mcp', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.registerTool(
    'cos_health',
    {
      title: 'Chat On Steroids health',
      description:
        'Checks whether Chat On Steroids is running and answering, and what is wrong if not. Returns state, summary, suggestedAction, issues, process metrics and recent log facts. Takes a few seconds when the app is silent.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => text(await gatherHealth(env, store))
  );

  server.registerTool(
    'cos_logs',
    {
      title: 'Chat On Steroids log',
      description: "Reads the app's own app.log (and the rotated app.log.1 when searching back). Oldest first.",
      inputSchema: z.object({
        lines: z.number().int().min(1).max(2000).default(200).describe('Maximum lines to return (the newest ones).'),
        minLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        contains: z.string().max(200).optional().describe('Case-insensitive text the message must contain.'),
        since: z.string().datetime().optional().describe('Only lines at or after this ISO timestamp.'),
        includeRotated: z.boolean().default(false).describe('Also read app.log.1 (older lines).')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ lines, minLevel, contains, since, includeRotated }) => {
      const entries = await readLog(env.userDataDir, includeRotated);
      const found = queryLog(entries, {
        limit: lines,
        minLevel,
        ...(contains ? { contains } : {}),
        ...(since ? { sinceMs: Date.parse(since) } : {})
      });
      return text(found.map((entry) => `${entry.at} ${entry.level.padEnd(5)} ${entry.message}`).join('\n') || '(no matching lines)');
    }
  );

  server.registerTool(
    'cos_journal',
    {
      title: 'cos-mcp journal',
      description: 'Lists the start/stop/restart actions taken through this server, newest last, with reasons, outcomes and evidence folders.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(20) }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ limit }) => text(await store.readJournal(limit))
  );

  if (options.readOnly) return server;

  server.registerTool(
    'cos_start',
    {
      title: 'Start Chat On Steroids',
      description:
        'Starts the app in the background (tray) and waits up to 2 minutes for it to answer. Refused if it is already running, while an update installs, or if the user closed it on purpose (unless userRequested).',
      inputSchema: controlInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (input) => text(await control(env, store, 'start', input))
  );

  server.registerTool(
    'cos_stop',
    {
      title: 'Stop Chat On Steroids',
      description:
        'Kills the app. Until the app offers a graceful quit this is always a forced kill, so it is refused while the app still answers unless force is true. Evidence is saved first. Later checks report stopped_by_user.',
      inputSchema: controlInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (input) => text(await control(env, store, 'stop', input))
  );

  server.registerTool(
    'cos_restart',
    {
      title: 'Restart Chat On Steroids',
      description:
        'Restarts a hung or dead app: re-checks a silent app for up to 45 s, saves evidence, kills it, starts it again and waits for it to answer. Refused while updating, for an app that still answers (unless force), and after 3 automatic restarts in an hour.',
      inputSchema: controlInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (input) => text(await control(env, store, 'restart', input))
  );

  return server;
}
