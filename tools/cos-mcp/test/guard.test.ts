import { describe, expect, it } from 'vitest';
import { decide, type ControlRequest } from '../src/guard.js';
import type { ControlAction } from '../src/store.js';

const now = Date.parse('2026-09-28T12:00:00Z');
const req = (kind: ControlRequest['kind'], extra: Partial<ControlRequest> = {}): ControlRequest => ({
  kind,
  reason: 'test',
  userRequested: false,
  force: false,
  ...extra
});
const minutesAgo = (minutes: number, kind: ControlAction['kind'] = 'restart', userRequested = false): ControlAction => ({
  at: new Date(now - minutes * 60_000).toISOString(),
  kind,
  userRequested
});

describe('decide', () => {
  it('never acts during an update, even when forced', () => {
    for (const kind of ['start', 'stop', 'restart'] as const) {
      expect(decide(req(kind, { force: true, userRequested: true }), 'updating', [], now).allowed).toBe(false);
    }
  });

  it('does not start an app the user closed unless the user asks', () => {
    expect(decide(req('start'), 'stopped_by_user', [], now).allowed).toBe(false);
    expect(decide(req('restart'), 'stopped_by_user', [], now).allowed).toBe(false);
    expect(decide(req('start', { userRequested: true }), 'stopped_by_user', [], now).allowed).toBe(true);
  });

  it('starts a crashed app but not a running one', () => {
    expect(decide(req('start'), 'down', [], now).allowed).toBe(true);
    expect(decide(req('start'), 'healthy', [], now).allowed).toBe(false);
    expect(decide(req('start'), 'not_responding', [], now)).toMatchObject({ allowed: false, why: expect.stringMatching(/cos_restart/) });
  });

  it('only kills an app that still answers when forced', () => {
    expect(decide(req('restart'), 'healthy', [], now).allowed).toBe(false);
    expect(decide(req('restart'), 'degraded', [], now).allowed).toBe(false);
    expect(decide(req('stop'), 'healthy', [], now).allowed).toBe(false);
    expect(decide(req('restart', { force: true }), 'healthy', [], now).allowed).toBe(true);
    expect(decide(req('restart'), 'not_responding', [], now).allowed).toBe(true);
    expect(decide(req('restart'), 'startup_hung', [], now).allowed).toBe(true);
  });

  it('gives a starting app time before a restart', () => {
    expect(decide(req('restart'), 'starting', [], now).allowed).toBe(false);
  });

  it('stops restarting after three automatic actions in an hour', () => {
    const three = [minutesAgo(50), minutesAgo(30), minutesAgo(5, 'start')];
    expect(decide(req('restart'), 'not_responding', three, now)).toMatchObject({ allowed: false, rateLimited: true });
    expect(decide(req('restart', { force: true }), 'not_responding', three, now).allowed).toBe(true);
    expect(decide(req('restart', { userRequested: true }), 'not_responding', three, now).allowed).toBe(true);
  });

  it('does not count old, user-requested or stop actions toward the limit', () => {
    const history = [minutesAgo(90), minutesAgo(70), minutesAgo(20, 'restart', true), minutesAgo(10, 'stop'), minutesAgo(5)];
    expect(decide(req('restart'), 'not_responding', history, now).allowed).toBe(true);
  });

  it('refuses to stop an app that is not running', () => {
    expect(decide(req('stop', { force: true }), 'down', [], now).allowed).toBe(false);
  });
});
