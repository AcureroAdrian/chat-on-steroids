import type { CosProcess } from '../src/processes.js';
import type { McpState } from '../src/store.js';

/** Builds app.log text in the app's own format: `<ISO>  <level padded>  <message>`. */
export function logText(lines: Array<[string, 'info' | 'warn' | 'error', string]>): string {
  return lines.map(([at, level, message]) => `${at}  ${level.padEnd(5)}  ${message}`).join('\n') + '\n';
}

export function mainProcess(startedAt: string, pid = 100): CosProcess {
  return {
    pid,
    ppid: 1,
    exe: 'C:\\Apps\\Chat On Steroids.exe',
    commandLine: '"C:\\Apps\\Chat On Steroids.exe"',
    startedAt,
    main: true,
    workingSetBytes: 100 * 1048576,
    threads: 40,
    handles: 1000,
    cpuSeconds: 12
  };
}

export const emptyState = (): McpState => ({
  lastResponsive: null,
  unresponsiveSince: null,
  lastExe: null,
  stoppedByAgent: null,
  recentActions: []
});

export const hello = { port: 8765, version: '2.1.19', bridgeProtocol: 14, paired: true, latencyMs: 4 };
