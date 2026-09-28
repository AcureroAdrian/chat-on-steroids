import { describe, expect, it } from 'vitest';
import { analyzeLog, parseLine, parseLog, queryLog } from '../src/log.js';
import { logText } from './helpers.js';

const at = (iso: string) => Date.parse(iso);

describe('parseLine', () => {
  it('reads the app format and strips an agent tag', () => {
    expect(parseLine('2026-09-21T18:53:11.489Z  info   [prime] desktop timing op=snapshot')).toMatchObject({
      level: 'info',
      message: 'desktop timing op=snapshot'
    });
  });

  it('ignores lines that are not log entries', () => {
    expect(parseLine('    at Object.<anonymous> (file.js:1:1)')).toBeNull();
  });
});

describe('analyzeLog lifecycle', () => {
  it('sees a clean exit after the last start', () => {
    const facts = analyzeLog(
      parseLog(
        logText([
          ['2026-09-28T02:21:03.967Z', 'info', 'app started'],
          ['2026-09-28T06:14:53.944Z', 'info', 'shutdown admission/drain starting'],
          ['2026-09-28T06:14:55.649Z', 'info', 'shutdown sequence complete']
        ])
      ),
      at('2026-09-28T06:20:00Z')
    );
    expect(facts.cleanExitAfterLastStart).toBe(true);
    expect(facts.lastLifecycle?.kind).toBe('shutdown_complete');
    expect(facts.update).toBeNull();
  });

  it('forgets the clean exit of a previous run once the app starts again', () => {
    const facts = analyzeLog(
      parseLog(
        logText([
          ['2026-09-28T06:14:55.649Z', 'info', 'shutdown sequence complete'],
          ['2026-09-28T07:00:00.000Z', 'info', 'app started']
        ])
      ),
      at('2026-09-28T07:05:00Z')
    );
    expect(facts.cleanExitAfterLastStart).toBe(false);
    expect(facts.lastStartAt).toBe('2026-09-28T07:00:00.000Z');
  });

  it('reads an update hand-off that relaunches, and one that does not', () => {
    const relaunch = analyzeLog(
      parseLog(
        logText([
          ['2026-09-28T01:03:10.684Z', 'info', 'app started'],
          ['2026-09-28T02:20:23.000Z', 'info', 'update: install requested; quitting to hand the update over'],
          ['2026-09-28T02:20:27.161Z', 'info', 'update: installing 2.1.16 now; the app starts itself again as the new version'],
          ['2026-09-28T02:20:27.161Z', 'info', 'shutdown sequence complete']
        ])
      ),
      at('2026-09-28T02:20:40Z')
    );
    expect(relaunch.update).toEqual({ at: '2026-09-28T02:20:27.161Z', relaunch: true, version: '2.1.16' });

    const handedOver = analyzeLog(
      parseLog(
        logText([
          ['2026-09-28T01:03:10.684Z', 'info', 'app started'],
          ['2026-09-28T02:20:27.161Z', 'info', 'update: 2.1.17 handed over; the next start of this app is the new version']
        ])
      ),
      at('2026-09-28T02:20:40Z')
    );
    expect(handedOver.update).toMatchObject({ relaunch: false, version: '2.1.17' });
  });
});

describe('analyzeLog signals', () => {
  it('counts persistence failures and other degradations inside the window only', () => {
    const facts = analyzeLog(
      parseLog(
        logText([
          ['2026-09-22T20:00:00.000Z', 'warn', 'could not save usage-cache state: ELOOP: old failure before the window'],
          ['2026-09-22T22:26:37.751Z', 'info', 'app started'],
          ['2026-09-22T22:28:00.000Z', 'error', 'session meta flush failed: ELOOP: too many symbolic links encountered'],
          ['2026-09-22T22:28:01.000Z', 'warn', 'could not save session-input state: ELOOP: too many symbolic links encountered'],
          ['2026-09-22T22:29:00.000Z', 'warn', 'request attribution: no page evidence for wfr_abc within 20000ms; filing read under Unattributed activity'],
          ['2026-09-22T22:29:30.000Z', 'warn', 'multi-agent: worker-2 failed — the browser could not start the chat'],
          ['2026-09-22T22:30:00.000Z', 'warn', 'bridge: the browser reported failed goal recovery for x (reloaded)']
        ])
      ),
      at('2026-09-22T22:32:00Z')
    );
    expect(facts.window).toMatchObject({
      persistenceFailures: 2,
      unattributedCalls: 1,
      workerFailures: 1,
      recoveryFailures: 1,
      errors: 1
    });
    expect(facts.window.since).toBe('2026-09-22T22:26:37.751Z');
  });

  it('treats an extension protocol mismatch as active until a later connection', () => {
    const lines: Array<[string, 'info' | 'warn', string]> = [
      ['2026-09-28T14:27:14.683Z', 'info', 'app started'],
      ['2026-09-28T14:27:39.987Z', 'info', 'bridge: browser extension 2.1.12 connected'],
      ['2026-09-28T14:27:39.988Z', 'warn', 'bridge: the browser extension speaks protocol 13 but this app speaks 14. Reload the extension from the folder shipped with app 2.1.18.']
    ];
    expect(analyzeLog(parseLog(logText(lines)), at('2026-09-28T14:28:00Z')).extensionIncompatible).toMatch(/protocol 13/);
    lines.push(['2026-09-28T14:28:27.268Z', 'info', 'bridge: browser extension 2.1.18 connected (build 1c50572c4826)']);
    expect(analyzeLog(parseLog(logText(lines)), at('2026-09-28T14:29:00Z')).extensionIncompatible).toBeNull();
  });

  it('keeps the first moment a tunnel went offline and clears it on reconnect', () => {
    const lines: Array<[string, 'info' | 'warn', string]> = [
      ['2026-09-24T08:00:00.000Z', 'info', 'app started'],
      ['2026-09-24T08:01:00.000Z', 'info', 'core tunnel connected'],
      ['2026-09-24T08:10:00.000Z', 'warn', 'core tunnel offline: the connection timed out (last verified handshake 60s ago)'],
      ['2026-09-24T08:20:00.000Z', 'warn', 'core tunnel offline: no internet connection (last verified handshake 660s ago)']
    ];
    const offline = analyzeLog(parseLog(logText(lines)), at('2026-09-24T08:25:00Z'));
    expect(offline.tunnels).toEqual([
      { surface: 'core', state: 'offline', since: '2026-09-24T08:10:00.000Z', detail: 'no internet connection (last verified handshake 660s ago)' }
    ]);
    lines.push(['2026-09-24T08:25:12.489Z', 'info', 'core tunnel connected']);
    expect(analyzeLog(parseLog(logText(lines)), at('2026-09-24T08:26:00Z')).tunnels[0]?.state).toBe('connected');
  });
});

describe('queryLog', () => {
  const entries = parseLog(
    logText([
      ['2026-09-28T10:00:00.000Z', 'info', 'core tunnel connected'],
      ['2026-09-28T10:01:00.000Z', 'warn', 'desktop tunnel offline: timed out'],
      ['2026-09-28T10:02:00.000Z', 'error', 'session meta flush failed: ELOOP'],
      ['2026-09-28T10:03:00.000Z', 'info', 'desktop tunnel connected']
    ])
  );

  it('filters by level, text and time and keeps the newest', () => {
    expect(queryLog(entries, { minLevel: 'warn', limit: 10 }).map((entry) => entry.level)).toEqual(['warn', 'error']);
    expect(queryLog(entries, { contains: 'DESKTOP', limit: 10 })).toHaveLength(2);
    expect(queryLog(entries, { sinceMs: at('2026-09-28T10:02:00Z'), limit: 10 })).toHaveLength(2);
    expect(queryLog(entries, { limit: 1 })[0]?.message).toBe('desktop tunnel connected');
  });
});
