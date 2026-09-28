import type { HealthState } from './health.js';
import type { ControlAction } from './store.js';

/**
 * The limits an agent works within. The agent decides when to act; these rules only stop it
 * from making things worse: overriding a deliberate close, fighting an updater, killing an app
 * that still answers, or restarting in a loop.
 */
export type ControlKind = 'start' | 'stop' | 'restart';

export interface ControlRequest {
  kind: ControlKind;
  reason: string;
  userRequested: boolean;
  force: boolean;
}

export type Decision = { allowed: true; note: string | null } | { allowed: false; why: string; rateLimited?: boolean };

export const MAX_AUTOMATIC_ACTIONS_PER_HOUR = 3;

const RUNNING: HealthState[] = ['healthy', 'degraded', 'not_responding', 'starting', 'startup_hung'];

export function automaticActionsInLastHour(actions: ControlAction[], nowMs: number): number {
  return actions.filter(
    (action) => !action.userRequested && action.kind !== 'stop' && nowMs - Date.parse(action.at) < 60 * 60_000
  ).length;
}

export function decide(request: ControlRequest, state: HealthState, recent: ControlAction[], nowMs: number): Decision {
  if (state === 'updating') {
    return { allowed: false, why: 'An update is being installed and the app restarts itself. Check again in a minute.' };
  }

  if (request.kind === 'stop') {
    if (state === 'down' || state === 'stopped_by_user') return { allowed: false, why: 'The app is not running.' };
    if ((state === 'healthy' || state === 'degraded') && !request.force) {
      return {
        allowed: false,
        why: 'The app is answering. Without the app-side control API there is no graceful quit yet, so stopping it means killing it; pass force: true if that is really intended.'
      };
    }
    return { allowed: true, note: null };
  }

  if (state === 'stopped_by_user' && !request.userRequested) {
    return {
      allowed: false,
      why: 'The app was closed on purpose. Start it only when the user asks for it (userRequested: true).'
    };
  }

  if (request.kind === 'start' && RUNNING.includes(state)) {
    return {
      allowed: false,
      why: state === 'not_responding' || state === 'startup_hung' ? 'The app is running but not answering; use cos_restart.' : 'The app is already running.'
    };
  }

  if (request.kind === 'restart') {
    if ((state === 'healthy' || state === 'degraded') && !request.force) {
      return {
        allowed: false,
        why: 'The app is answering. A restart would kill a working app (there is no graceful quit without the app-side control API yet); pass force: true if that is really intended.'
      };
    }
    if (state === 'starting' && !request.force) {
      return { allowed: false, why: 'The app is still starting; give it up to two minutes before restarting it.' };
    }
  }

  if (!request.userRequested && !request.force) {
    const count = automaticActionsInLastHour(recent, nowMs);
    if (count >= MAX_AUTOMATIC_ACTIONS_PER_HOUR) {
      return {
        allowed: false,
        rateLimited: true,
        why: `${count} automatic starts/restarts in the last hour. Something keeps failing; tell the user instead of restarting again (or pass force: true with a reason).`
      };
    }
  }

  const note = request.kind === 'restart' && (state === 'down' || state === 'stopped_by_user') ? 'The app was not running; this is a plain start.' : null;
  return { allowed: true, note };
}
