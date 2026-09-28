import { describe, expect, it } from 'vitest';
import { classify, restartedSinceLastLine } from '../src/health.js';
import { analyzeLog, parseLog } from '../src/log.js';
import { emptyState, hello, logText, mainProcess } from './helpers.js';

const at = (iso: string) => Date.parse(iso);

function facts(lines: Array<[string, 'info' | 'warn' | 'error', string]>, now: string) {
  return analyzeLog(parseLog(logText(lines)), at(now));
}

const started: Array<[string, 'info', string]> = [['2026-09-26T13:08:06.069Z', 'info', 'app started']];

describe('classify', () => {
  it('is healthy when the main process answers and nothing is wrong', () => {
    const now = '2026-09-26T13:30:00Z';
    const v = classify({ nowMs: at(now), processes: [mainProcess('2026-09-26T13:07:40Z')], hello, facts: facts(started, now), state: emptyState() });
    expect(v.state).toBe('healthy');
  });

  it('is degraded, not restarted, when the app answers but cannot write its state', () => {
    const now = '2026-09-26T13:30:00Z';
    const v = classify({
      nowMs: at(now),
      processes: [mainProcess('2026-09-26T13:07:40Z')],
      hello,
      facts: facts([...started, ['2026-09-26T13:20:00.000Z', 'error', 'session meta flush failed: ELOOP']], now),
      state: emptyState()
    });
    expect(v.state).toBe('degraded');
    expect(v.issues.map((issue) => issue.code)).toEqual(['persistence_failures']);
  });

  it('reports a finished startup that went silent as not_responding, even on a first check', () => {
    // The 10-hour silence right after a start: the log shows the start completed, then nothing.
    const now = '2026-09-26T23:00:00Z';
    const v = classify({ nowMs: at(now), processes: [mainProcess('2026-09-26T13:07:40Z')], hello: null, facts: facts(started, now), state: emptyState() });
    expect(v.state).toBe('not_responding');
  });

  it('separates a slow start from a start that never finished', () => {
    const lines: Array<[string, 'warn', string]> = [['2026-09-28T00:44:25.849Z', 'warn', 'Skills library unavailable: ELOOP']];
    const early = '2026-09-28T00:45:10Z';
    const late = '2026-09-28T00:49:25Z';
    const proc = [mainProcess('2026-09-28T00:44:10Z')];
    expect(classify({ nowMs: at(early), processes: proc, hello: null, facts: facts(lines, early), state: emptyState() }).state).toBe('starting');
    expect(classify({ nowMs: at(late), processes: proc, hello: null, facts: facts(lines, late), state: emptyState() }).state).toBe('startup_hung');
  });

  it('treats a process that answered before as not_responding without needing the log', () => {
    const now = '2026-09-26T13:30:00Z';
    const state = { ...emptyState(), lastResponsive: { pid: 100, at: '2026-09-26T13:10:00Z' } };
    const v = classify({ nowMs: at(now), processes: [mainProcess('2026-09-20T10:00:00Z')], hello: null, facts: facts([], now), state });
    expect(v.state).toBe('not_responding');
  });

  it('respects a clean quit, including one made through cos_stop', () => {
    const now = '2026-09-28T06:20:00Z';
    const quit = facts(
      [
        ['2026-09-28T02:21:03.967Z', 'info', 'app started'],
        ['2026-09-28T06:14:55.649Z', 'info', 'shutdown sequence complete']
      ],
      now
    );
    expect(classify({ nowMs: at(now), processes: [], hello: null, facts: quit, state: emptyState() }).state).toBe('stopped_by_user');

    const killed = facts([['2026-09-28T02:21:03.967Z', 'info', 'app started']], now);
    expect(classify({ nowMs: at(now), processes: [], hello: null, facts: killed, state: emptyState() }).state).toBe('down');
    const stoppedByAgent = { ...emptyState(), stoppedByAgent: { at: '2026-09-28T06:00:00.000Z', reason: 'user asked', userRequested: true } };
    expect(classify({ nowMs: at(now), processes: [], hello: null, facts: killed, state: stoppedByAgent }).state).toBe('stopped_by_user');
  });

  it('waits for an update hand-off, then calls a missing app down', () => {
    const lines: Array<[string, 'info', string]> = [
      ['2026-09-28T01:03:10.684Z', 'info', 'app started'],
      ['2026-09-28T02:20:27.161Z', 'info', 'update: installing 2.1.16 now; the app starts itself again as the new version'],
      ['2026-09-28T02:20:27.161Z', 'info', 'shutdown sequence complete']
    ];
    const soon = '2026-09-28T02:21:00Z';
    const much_later = '2026-09-28T03:00:00Z';
    expect(classify({ nowMs: at(soon), processes: [], hello: null, facts: facts(lines, soon), state: emptyState() }).state).toBe('updating');
    expect(classify({ nowMs: at(much_later), processes: [], hello: null, facts: facts(lines, much_later), state: emptyState() }).state).toBe('down');
  });

  it('attributes a missing app to a machine restart only when the boot came after the last line', () => {
    expect(restartedSinceLastLine(at('2026-09-28T20:00:00Z'), '2026-09-28T18:59:51.143Z')).toBe(true);
    expect(restartedSinceLastLine(at('2026-09-28T08:00:00Z'), '2026-09-28T18:59:51.143Z')).toBe(false);
    expect(restartedSinceLastLine(at('2026-09-28T20:00:00Z'), null)).toBe(false);
  });

  it('flags a tunnel only after it has been offline for a while', () => {
    const lines: Array<[string, 'info' | 'warn', string]> = [
      ['2026-09-24T08:00:00.000Z', 'info', 'app started'],
      ['2026-09-24T08:10:00.000Z', 'warn', 'core tunnel offline: the connection timed out']
    ];
    const proc = [mainProcess('2026-09-24T07:59:30Z')];
    const early = '2026-09-24T08:12:00Z';
    const late = '2026-09-24T08:25:00Z';
    expect(classify({ nowMs: at(early), processes: proc, hello, facts: facts(lines, early), state: emptyState() }).state).toBe('healthy');
    const v = classify({ nowMs: at(late), processes: proc, hello, facts: facts(lines, late), state: emptyState() });
    expect(v.state).toBe('degraded');
    expect(v.issues[0]?.code).toBe('tunnel_offline');
  });
});
