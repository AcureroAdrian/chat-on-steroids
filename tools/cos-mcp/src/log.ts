import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reading the app's own app.log (and its rotated app.log.1).
 *
 * The message texts are not an API: any release may reword them. Everything here therefore
 * degrades to "not seen" rather than to a wrong conclusion, and the live control surface
 * replaces this once the app offers one.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Level[] = ['debug', 'info', 'warn', 'error'];

export interface LogEntry {
  at: string;
  ms: number;
  level: Level;
  message: string;
}

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(debug|info|warn|error)\s+(.*)$/;

export function parseLine(line: string): LogEntry | null {
  const match = line.match(LINE);
  if (!match) return null;
  const ms = Date.parse(match[1]!);
  if (Number.isNaN(ms)) return null;
  // Lines written while an agent context is active carry a `[prime] ` style tag.
  const message = match[3]!.replace(/^\[[^\]]{1,40}\]\s+/, '');
  return { at: match[1]!, ms, level: match[2] as Level, message };
}

export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Oldest first. The app rotates app.log into app.log.1 at 4 MiB, so both together stay small. */
export async function readLog(userDataDir: string, includeRotated: boolean): Promise<LogEntry[]> {
  const current = await readIfExists(path.join(userDataDir, 'app.log'));
  const rotated = includeRotated ? await readIfExists(path.join(userDataDir, 'app.log.1')) : '';
  return parseLog(rotated + '\n' + current);
}

export interface LogQuery {
  minLevel?: Level;
  contains?: string;
  sinceMs?: number;
  limit: number;
}

export function queryLog(entries: LogEntry[], query: LogQuery): LogEntry[] {
  const floor = LEVELS.indexOf(query.minLevel ?? 'debug');
  const needle = query.contains?.toLowerCase();
  const matched = entries.filter(
    (entry) =>
      LEVELS.indexOf(entry.level) >= floor &&
      (query.sinceMs === undefined || entry.ms >= query.sinceMs) &&
      (!needle || entry.message.toLowerCase().includes(needle))
  );
  return matched.slice(-query.limit);
}

export type LifecycleKind = 'started' | 'shutdown_complete' | 'update_requested' | 'update_relaunching' | 'update_handed_over';

export interface TunnelFact {
  surface: string;
  state: 'connected' | 'offline' | 'disconnected' | 'failed';
  since: string;
  detail: string | null;
}

export interface LogFacts {
  lastEntryAt: string | null;
  lastLifecycle: { kind: LifecycleKind; at: string } | null;
  lastStartAt: string | null;
  /** The shutdown sequence ran to completion after the most recent start. */
  cleanExitAfterLastStart: boolean;
  /** An update hand-off logged after the most recent start. */
  update: { at: string; relaunch: boolean | null; version: string | null } | null;
  /** The browser extension currently connected speaks an older or newer bridge protocol. */
  extensionIncompatible: string | null;
  tunnels: TunnelFact[];
  window: {
    since: string;
    warnings: number;
    errors: number;
    persistenceFailures: number;
    lastPersistenceFailure: string | null;
    unattributedCalls: number;
    workerFailures: number;
    recoveryFailures: number;
  };
}

function lifecycleOf(message: string): LifecycleKind | null {
  if (message === 'app started') return 'started';
  if (message === 'shutdown sequence complete') return 'shutdown_complete';
  if (message.startsWith('update: install requested')) return 'update_requested';
  if (/^update: installing \S+ now; the app starts itself again/.test(message)) return 'update_relaunching';
  if (/^update: \S+ handed over; the next start/.test(message)) return 'update_handed_over';
  return null;
}

const PERSISTENCE = /could not save [\w-]+ state|meta flush failed|message upsert failed|could not persist|recorder could not admit|ENOSPC/i;
const EXTENSION_MISMATCH = /the browser extension speaks protocol \d+ but this app speaks \d+/;
const EXTENSION_CONNECTED = /^bridge: browser extension \S+ connected/;
const UNATTRIBUTED = /^request attribution: no page evidence for /;
const WORKER_FAILURE = /^multi-agent: (?:worker-\d+ failed|could not wake worker)|^bridge: gave up on revive/;
const RECOVERY_FAILURE = /reported failed \w+ recovery/;
const TUNNEL_CONNECTED = /^(core|desktop|plugins) tunnel connected$/;
const TUNNEL_OFFLINE = /^(core|desktop|plugins) tunnel offline: (.*)$/;

export function analyzeLog(entries: LogEntry[], nowMs: number, windowMs = 30 * 60_000): LogFacts {
  let lastStartIndex = -1;
  let lastLifecycle: LogFacts['lastLifecycle'] = null;
  entries.forEach((entry, index) => {
    const kind = lifecycleOf(entry.message);
    if (!kind) return;
    lastLifecycle = { kind, at: entry.at };
    if (kind === 'started') lastStartIndex = index;
  });

  const sinceStart = lastStartIndex >= 0 ? entries.slice(lastStartIndex + 1) : entries;
  let cleanExitAfterLastStart = false;
  let update: LogFacts['update'] = null;
  let mismatch: { index: number; message: string } | null = null;
  let connectedIndex = -1;
  const tunnels = new Map<string, TunnelFact>();

  sinceStart.forEach((entry, index) => {
    const { message } = entry;
    const kind = lifecycleOf(message);
    if (kind === 'shutdown_complete') cleanExitAfterLastStart = true;
    if (kind === 'update_requested') update = { at: entry.at, relaunch: null, version: null };
    if (kind === 'update_relaunching' || kind === 'update_handed_over') {
      update = {
        at: entry.at,
        relaunch: kind === 'update_relaunching',
        version: message.match(/^update: (?:installing )?(\S+)/)?.[1] ?? null
      };
    }
    if (EXTENSION_MISMATCH.test(message)) mismatch = { index, message };
    if (EXTENSION_CONNECTED.test(message)) connectedIndex = index;

    const connected = message.match(TUNNEL_CONNECTED);
    const offline = message.match(TUNNEL_OFFLINE);
    if (connected) tunnels.set(connected[1]!, { surface: connected[1]!, state: 'connected', since: entry.at, detail: null });
    else if (offline) {
      const previous = tunnels.get(offline[1]!);
      // Keep the first moment it went offline, not the latest repeat of the same complaint.
      const since = previous?.state === 'offline' ? previous.since : entry.at;
      tunnels.set(offline[1]!, { surface: offline[1]!, state: 'offline', since, detail: offline[2] ?? null });
    } else if (message === 'disconnected') {
      for (const surface of tunnels.keys()) tunnels.set(surface, { surface, state: 'disconnected', since: entry.at, detail: null });
    } else if (message.startsWith('connect failed:')) {
      tunnels.set('core', { surface: 'core', state: 'failed', since: entry.at, detail: message.slice('connect failed:'.length).trim() });
    }
  });

  const startMs = lastStartIndex >= 0 ? entries[lastStartIndex]!.ms : Number.NEGATIVE_INFINITY;
  const sinceMs = Math.max(startMs, nowMs - windowMs);
  const window: LogFacts['window'] = {
    since: new Date(sinceMs).toISOString(),
    warnings: 0,
    errors: 0,
    persistenceFailures: 0,
    lastPersistenceFailure: null,
    unattributedCalls: 0,
    workerFailures: 0,
    recoveryFailures: 0
  };
  for (const entry of entries) {
    if (entry.ms < sinceMs) continue;
    if (entry.level === 'warn') window.warnings += 1;
    if (entry.level === 'error') window.errors += 1;
    if (PERSISTENCE.test(entry.message)) {
      window.persistenceFailures += 1;
      window.lastPersistenceFailure = `${entry.at} ${entry.message}`.slice(0, 300);
    }
    if (UNATTRIBUTED.test(entry.message)) window.unattributedCalls += 1;
    if (WORKER_FAILURE.test(entry.message)) window.workerFailures += 1;
    if (RECOVERY_FAILURE.test(entry.message)) window.recoveryFailures += 1;
  }

  const activeMismatch = mismatch as { index: number; message: string } | null;
  return {
    lastEntryAt: entries.at(-1)?.at ?? null,
    lastLifecycle,
    lastStartAt: lastStartIndex >= 0 ? entries[lastStartIndex]!.at : null,
    cleanExitAfterLastStart,
    update,
    extensionIncompatible: activeMismatch && activeMismatch.index > connectedIndex ? activeMismatch.message : null,
    tunnels: [...tunnels.values()],
    window
  };
}
