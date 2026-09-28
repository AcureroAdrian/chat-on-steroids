import os from 'node:os';
import { probeResponsive, type HelloReply } from './bridge.js';
import type { CosEnv } from './env.js';
import { analyzeLog, readLog, type LogFacts } from './log.js';
import { listCosProcesses, pickMain, type CosProcess } from './processes.js';
import type { McpState, Store } from './store.js';

export type HealthState =
  | 'healthy'
  | 'degraded'
  | 'not_responding'
  | 'starting'
  | 'startup_hung'
  | 'updating'
  | 'stopped_by_user'
  | 'down';

export type SuggestedAction = 'none' | 'wait' | 'start' | 'restart' | 'investigate';

export interface Issue {
  code:
    | 'persistence_failures'
    | 'extension_incompatible'
    | 'browser_not_paired'
    | 'tunnel_offline'
    | 'connection_failed'
    | 'unattributed_calls'
    | 'worker_failures'
    | 'recovery_failures'
    | 'process_listing_failed';
  detail: string;
}

export interface Health {
  state: HealthState;
  checkedAt: string;
  summary: string;
  suggestedAction: SuggestedAction;
  suggestion: string;
  process: {
    pid: number;
    startedAt: string | null;
    uptimeSeconds: number | null;
    exe: string | null;
    workingSetMB: number | null;
    threads: number | null;
    handles: number | null;
    cpuSeconds: number | null;
    helperProcesses: number;
  } | null;
  responding: HelloReply | null;
  lastRespondedAt: string | null;
  notRespondingSince: string | null;
  issues: Issue[];
  log: Pick<LogFacts, 'lastEntryAt' | 'lastStartAt' | 'lastLifecycle' | 'update' | 'tunnels' | 'window'>;
}

export interface Thresholds {
  startupGraceMs: number;
  updateWindowMs: number;
  tunnelOfflineMs: number;
  unattributedCalls: number;
  workerFailures: number;
  recoveryFailures: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  startupGraceMs: 120_000,
  updateWindowMs: 10 * 60_000,
  tunnelOfflineMs: 10 * 60_000,
  unattributedCalls: 20,
  workerFailures: 5,
  recoveryFailures: 5
};

export interface ClassifyInput {
  nowMs: number;
  /** null when the process list itself could not be read. */
  processes: CosProcess[] | null;
  hello: HelloReply | null;
  facts: LogFacts;
  state: McpState;
  thresholds?: Thresholds;
}

const SUGGESTIONS: Record<HealthState, { action: SuggestedAction; text: string }> = {
  healthy: { action: 'none', text: 'Nothing to do.' },
  degraded: {
    action: 'investigate',
    text: 'The app answers but something inside it is wrong; see issues. A restart does not fix these by itself.'
  },
  not_responding: {
    action: 'restart',
    text: 'The main process stopped answering. cos_restart re-checks for up to 45 s before it kills anything.'
  },
  starting: { action: 'wait', text: 'The app is still starting. Check again in about 30 seconds.' },
  startup_hung: { action: 'restart', text: 'The app never finished starting. cos_restart can kill it and start it again.' },
  updating: { action: 'wait', text: 'An update is being installed; the app starts itself again. Do not touch it; check again in a minute.' },
  stopped_by_user: {
    action: 'none',
    text: 'The app was closed on purpose. Start it only if the user asks (cos_start with userRequested: true).'
  },
  down: { action: 'start', text: 'The app is not running and was not closed cleanly. cos_start can start it.' }
};

function issuesFor(input: ClassifyInput, t: Thresholds): Issue[] {
  const { facts, hello, nowMs } = input;
  const issues: Issue[] = [];
  const w = facts.window;
  if (w.persistenceFailures > 0) {
    issues.push({
      code: 'persistence_failures',
      detail: `${w.persistenceFailures} failed state writes since ${w.since}. Last: ${w.lastPersistenceFailure ?? 'n/a'}`
    });
  }
  if (facts.extensionIncompatible) {
    issues.push({
      code: 'extension_incompatible',
      detail: `${facts.extensionIncompatible}. The user has to reload the extension in Chrome.`
    });
  }
  if (hello?.paired === false) {
    issues.push({ code: 'browser_not_paired', detail: 'No browser extension is paired with the app.' });
  }
  for (const tunnel of facts.tunnels) {
    const age = nowMs - Date.parse(tunnel.since);
    if (tunnel.state === 'offline' && age >= t.tunnelOfflineMs) {
      issues.push({
        code: 'tunnel_offline',
        detail: `${tunnel.surface} tunnel offline since ${tunnel.since} (${Math.round(age / 60_000)} min): ${tunnel.detail ?? ''}`.trim()
      });
    }
    if (tunnel.state === 'failed') {
      issues.push({ code: 'connection_failed', detail: `Connect failed at ${tunnel.since}: ${tunnel.detail ?? ''}`.trim() });
    }
  }
  if (w.unattributedCalls >= t.unattributedCalls) {
    issues.push({ code: 'unattributed_calls', detail: `${w.unattributedCalls} tool calls could not be tied to a chat since ${w.since}.` });
  }
  if (w.workerFailures >= t.workerFailures) {
    issues.push({ code: 'worker_failures', detail: `${w.workerFailures} worker failures since ${w.since}.` });
  }
  if (w.recoveryFailures >= t.recoveryFailures) {
    issues.push({ code: 'recovery_failures', detail: `${w.recoveryFailures} failed automatic recoveries since ${w.since}.` });
  }
  if (input.processes === null) {
    issues.push({ code: 'process_listing_failed', detail: 'The process list could not be read; state is based on the bridge alone.' });
  }
  return issues;
}

export function classify(input: ClassifyInput): { state: HealthState; issues: Issue[]; main: CosProcess | null } {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const { facts, hello, nowMs, state } = input;
  const main = input.processes ? pickMain(input.processes) : null;
  const issues = issuesFor(input, t);
  const update = facts.update;
  const updateInFlight = update !== null && update.relaunch !== false && nowMs - Date.parse(update.at) < t.updateWindowMs;

  if (hello) return { state: issues.some((issue) => issue.code !== 'process_listing_failed') ? 'degraded' : 'healthy', issues, main };

  if (!main) {
    if (updateInFlight) return { state: 'updating', issues, main };
    const stopped = state.stoppedByAgent;
    if (stopped && (!facts.lastStartAt || stopped.at >= facts.lastStartAt)) return { state: 'stopped_by_user', issues, main };
    if (facts.cleanExitAfterLastStart && update?.relaunch !== true) return { state: 'stopped_by_user', issues, main };
    return { state: 'down', issues, main };
  }

  if (updateInFlight) return { state: 'updating', issues, main };
  const startedMs = main.startedAt ? Date.parse(main.startedAt) : Number.NaN;
  // "app started" is logged near the end of startup; seeing it after this process began means
  // startup finished, so silence now is a hang, not a slow start.
  const finishedStartup =
    state.lastResponsive?.pid === main.pid ||
    (facts.lastStartAt !== null && !Number.isNaN(startedMs) && Date.parse(facts.lastStartAt) >= startedMs - 5_000);
  if (finishedStartup) return { state: 'not_responding', issues, main };
  if (!Number.isNaN(startedMs) && nowMs - startedMs < t.startupGraceMs) return { state: 'starting', issues, main };
  return { state: 'startup_hung', issues, main };
}

/**
 * A machine restart ends the app without its shutdown sequence, exactly like a crash. When the
 * machine booted after the app's last log line, the restart is the likely cause.
 */
export function restartedSinceLastLine(bootMs: number, lastEntryAt: string | null): boolean {
  return lastEntryAt !== null && bootMs > Date.parse(lastEntryAt);
}

function summaryFor(state: HealthState, main: CosProcess | null, hello: HelloReply | null, since: string | null): string {
  switch (state) {
    case 'healthy':
      return `Chat On Steroids ${hello?.version ?? ''} is running and answering (pid ${main?.pid ?? '?'}).`.replace('  ', ' ');
    case 'degraded':
      return `Chat On Steroids ${hello?.version ?? ''} is answering, but reports problems.`.replace('  ', ' ');
    case 'not_responding':
      return `Chat On Steroids (pid ${main?.pid}) is running but its main process is not answering (seen since ${since}).`;
    case 'starting':
      return `Chat On Steroids (pid ${main?.pid}) is starting.`;
    case 'startup_hung':
      return `Chat On Steroids (pid ${main?.pid}) started at ${main?.startedAt} and never finished starting.`;
    case 'updating':
      return 'Chat On Steroids is installing an update.';
    case 'stopped_by_user':
      return 'Chat On Steroids is closed; it was closed on purpose.';
    case 'down':
      return 'Chat On Steroids is not running and did not close cleanly.';
  }
}

export async function gatherHealth(env: CosEnv, store: Store, nowMs = Date.now()): Promise<Health> {
  const processes = await listCosProcesses(env).catch(() => null);
  const main = processes ? pickMain(processes) : null;
  // Without a process there is nothing to wait for; with one, spread a few attempts over ~6 s.
  const hello = await probeResponsive(env.bridgePorts, main || processes === null ? 3 : 1);
  const facts = analyzeLog(await readLog(env.userDataDir, false), nowMs);
  const state = await store.readState();
  const verdict = classify({ nowMs, processes, hello, facts, state });
  const now = new Date(nowMs).toISOString();

  const next = await store.updateState((current) => {
    if (verdict.main?.exe) current.lastExe = verdict.main.exe;
    if (verdict.main) current.stoppedByAgent = null;
    if (hello) {
      current.lastResponsive = { pid: verdict.main?.pid ?? -1, at: now };
      current.unresponsiveSince = null;
    } else if (verdict.main && current.unresponsiveSince?.pid !== verdict.main.pid) {
      current.unresponsiveSince = { pid: verdict.main.pid, at: now };
    } else if (!verdict.main) {
      current.unresponsiveSince = null;
    }
  });

  const notRespondingSince =
    verdict.state === 'not_responding' || verdict.state === 'startup_hung' ? (next.unresponsiveSince?.at ?? now) : null;
  const suggestion = SUGGESTIONS[verdict.state];
  const helpers = processes ? processes.filter((item) => !item.main).length : 0;
  const m = verdict.main;
  let summary = summaryFor(verdict.state, m, hello, notRespondingSince);
  if (verdict.state === 'down' && restartedSinceLastLine(nowMs - os.uptime() * 1000, facts.lastEntryAt)) {
    summary += " The computer restarted after the app's last log line, so the restart most likely ended it, not a crash.";
  }
  return {
    state: verdict.state,
    checkedAt: now,
    summary,
    suggestedAction: suggestion.action,
    suggestion: suggestion.text,
    process: m
      ? {
          pid: m.pid,
          startedAt: m.startedAt,
          uptimeSeconds: m.startedAt ? Math.round((nowMs - Date.parse(m.startedAt)) / 1000) : null,
          exe: m.exe,
          workingSetMB: m.workingSetBytes === null ? null : Math.round(m.workingSetBytes / 1048576),
          threads: m.threads,
          handles: m.handles,
          cpuSeconds: m.cpuSeconds,
          helperProcesses: helpers
        }
      : null,
    responding: hello,
    lastRespondedAt: next.lastResponsive?.at ?? null,
    notRespondingSince,
    issues: verdict.issues,
    log: {
      lastEntryAt: facts.lastEntryAt,
      lastStartAt: facts.lastStartAt,
      lastLifecycle: facts.lastLifecycle,
      update: facts.update,
      tunnels: facts.tunnels,
      window: facts.window
    }
  };
}
