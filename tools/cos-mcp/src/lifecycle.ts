import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { probeHello } from './bridge.js';
import type { CosEnv } from './env.js';
import { decide, type ControlKind } from './guard.js';
import { gatherHealth, type Health, type HealthState } from './health.js';
import { notify } from './notify.js';
import { killTree, launch, listCosProcesses, pickMain } from './processes.js';
import type { Store } from './store.js';

export interface ControlOptions {
  reason: string;
  userRequested: boolean;
  force: boolean;
}

export interface ControlResult {
  outcome: 'done' | 'refused' | 'failed' | 'aborted';
  message: string;
  before: HealthState;
  after: Health | null;
  incident: string | null;
}

export interface Timing {
  /** How long a not-answering app is re-checked before it is killed. */
  confirmMs: number;
  /** How long a started app gets to answer. */
  startMs: number;
  /** How long a killed app gets to disappear. */
  exitMs: number;
  pollMs: number;
}

export const DEFAULT_TIMING: Timing = { confirmMs: 45_000, startMs: 120_000, exitMs: 20_000, pollMs: 2_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One control action at a time across every agent session on this machine. */
async function withLock<T>(store: Store, run: () => Promise<T>): Promise<T | null> {
  const lock = path.join(store.homeDir, 'control.lock');
  try {
    const info = await stat(lock);
    // A lock older than any action can take was left by a crashed session.
    if (Date.now() - info.mtimeMs > 10 * 60_000) await rm(lock, { force: true });
  } catch {
    // No lock.
  }
  let handle;
  try {
    await mkdir(store.homeDir, { recursive: true });
    handle = await open(lock, 'wx');
  } catch {
    return null;
  }
  try {
    await handle.write(`${process.pid} ${new Date().toISOString()}\n`);
    return await run();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

async function tailLines(file: string, count: number): Promise<string> {
  try {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    return lines.slice(-count).join('\n');
  } catch {
    return '';
  }
}

async function captureEvidence(env: CosEnv, store: Store, health: Health, kind: ControlKind): Promise<string> {
  const processes = await listCosProcesses(env).catch((error: Error) => ({ error: error.message }));
  return store.writeIncident(kind, {
    'health.json': JSON.stringify(health, null, 2),
    'processes.json': JSON.stringify(processes, null, 2),
    'app-log-tail.txt': await tailLines(path.join(env.userDataDir, 'app.log'), 500)
  });
}

/** True if the app answered again during the window, i.e. it was a slow moment, not a hang. */
async function answersWithin(env: CosEnv, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probeHello(env.bridgePorts)) return true;
    await sleep(pollMs);
  }
  return false;
}

async function waitForExit(env: CosEnv, timing: Timing): Promise<boolean> {
  const deadline = Date.now() + timing.exitMs;
  while (Date.now() < deadline) {
    if (!pickMain(await listCosProcesses(env))) return true;
    await sleep(1_000);
  }
  return false;
}

async function waitForAnswer(env: CosEnv, timing: Timing): Promise<boolean> {
  const deadline = Date.now() + timing.startMs;
  while (Date.now() < deadline) {
    if (await probeHello(env.bridgePorts)) return true;
    await sleep(timing.pollMs);
  }
  return false;
}

export async function control(
  env: CosEnv,
  store: Store,
  kind: ControlKind,
  options: ControlOptions,
  timing: Timing = DEFAULT_TIMING
): Promise<ControlResult> {
  const locked = await withLock(store, () => controlLocked(env, store, kind, options, timing));
  if (locked) return locked;
  return {
    outcome: 'refused',
    message: 'Another start/stop/restart is in progress (possibly from another agent session). Check cos_health in a minute.',
    before: 'down',
    after: null,
    incident: null
  };
}

async function controlLocked(env: CosEnv, store: Store, kind: ControlKind, options: ControlOptions, timing: Timing): Promise<ControlResult> {
  const before = await gatherHealth(env, store);
  const state = await store.readState();
  const decision = decide({ kind, ...options }, before.state, state.recentActions, Date.now());

  const finish = async (result: ControlResult): Promise<ControlResult> => {
    await store.appendJournal({
      at: new Date().toISOString(),
      tool: `cos_${kind}`,
      reason: options.reason,
      userRequested: options.userRequested,
      force: options.force,
      before: before.state,
      after: result.after?.state ?? null,
      outcome: result.outcome,
      detail: result.message,
      incident: result.incident
    });
    return result;
  };

  if (!decision.allowed) {
    if (decision.rateLimited) {
      await notify('Chat On Steroids needs attention', 'The agent reached the restart limit. The app keeps failing.');
    }
    return finish({ outcome: 'refused', message: decision.why, before: before.state, after: before, incident: null });
  }

  let incident: string | null = null;
  const running = before.process !== null;

  if (running && (kind === 'stop' || kind === 'restart')) {
    const unresponsive = before.state === 'not_responding' || before.state === 'startup_hung';
    if (unresponsive && !options.force && (await answersWithin(env, timing.confirmMs, timing.pollMs))) {
      return finish({
        outcome: 'aborted',
        message: `The app answered again within ${Math.round(timing.confirmMs / 1000)} s; nothing was killed.`,
        before: before.state,
        after: await gatherHealth(env, store),
        incident: null
      });
    }
    incident = await captureEvidence(env, store, before, kind);
    await killTree(env, before.process!.pid);
    if (!(await waitForExit(env, timing))) {
      await notify('Chat On Steroids could not be stopped', 'The process survived a forced kill.');
      return finish({
        outcome: 'failed',
        message: `pid ${before.process!.pid} was still running ${Math.round(timing.exitMs / 1000)} s after the kill.`,
        before: before.state,
        after: await gatherHealth(env, store),
        incident
      });
    }
  }

  const at = new Date().toISOString();
  if (kind === 'stop') {
    await store.updateState((current) => {
      current.stoppedByAgent = { at, reason: options.reason, userRequested: options.userRequested };
      current.recentActions.push({ at, kind, userRequested: options.userRequested });
    });
    return finish({
      outcome: 'done',
      message: `Stopped pid ${before.process?.pid}. Evidence saved in ${store.incidentPath(incident!)}.`,
      before: before.state,
      after: await gatherHealth(env, store),
      incident
    });
  }

  const exe = (await store.readState()).lastExe ?? before.process?.exe ?? env.defaultExe;
  if (!exe || !existsSync(exe)) {
    return finish({
      outcome: 'failed',
      message: `The app's executable was not found (${exe ?? 'unknown'}). Set COS_EXE for cos-mcp.`,
      before: before.state,
      after: null,
      incident
    });
  }
  await store.updateState((current) => {
    current.stoppedByAgent = null;
    current.recentActions.push({ at, kind, userRequested: options.userRequested });
  });
  launch(exe);
  const answered = await waitForAnswer(env, timing);
  const after = await gatherHealth(env, store);
  if (running) {
    await notify(
      answered ? 'Chat On Steroids was restarted' : 'Chat On Steroids did not come back',
      `${options.reason}`.slice(0, 200)
    );
  } else if (!answered) {
    await notify('Chat On Steroids did not start', 'It did not answer within two minutes of being started.');
  }
  const verb = running ? 'Restarted' : 'Started';
  return finish({
    outcome: answered ? 'done' : 'failed',
    message: answered
      ? `${verb} the app (now ${after.state}).${decision.note ? ' ' + decision.note : ''}${incident ? ` Evidence from before the kill: ${store.incidentPath(incident)}.` : ''}`
      : `${verb} the app, but it did not answer within ${Math.round(timing.startMs / 1000)} s (now ${after.state}).`,
    before: before.state,
    after,
    incident
  });
}
