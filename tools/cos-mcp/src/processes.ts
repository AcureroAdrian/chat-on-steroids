import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import type { CosEnv } from './env.js';

export interface CosProcess {
  pid: number;
  ppid: number;
  exe: string | null;
  commandLine: string;
  startedAt: string | null;
  /** Electron's main process: the only one launched without a `--type=` switch. */
  main: boolean;
  workingSetBytes: number | null;
  threads: number | null;
  handles: number | null;
  cpuSeconds: number | null;
}

function run(file: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function isMainCommandLine(commandLine: string): boolean {
  return !/\s--type=/.test(commandLine);
}

interface CimRow {
  ProcessId: number;
  ParentProcessId: number;
  ExecutablePath: string | null;
  CommandLine: string | null;
  CreationDate: string | null;
  WorkingSetSize: number | string | null;
  ThreadCount: number | null;
  HandleCount: number | null;
  CpuTicks: number | string | null;
}

export function parseCimJson(json: string): CosProcess[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as CimRow | CimRow[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    const commandLine = row.CommandLine ?? '';
    const ticks = row.CpuTicks === null || row.CpuTicks === undefined ? null : Number(row.CpuTicks);
    return {
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      exe: row.ExecutablePath ?? null,
      commandLine,
      startedAt: row.CreationDate ?? null,
      main: isMainCommandLine(commandLine),
      workingSetBytes: row.WorkingSetSize === null ? null : Number(row.WorkingSetSize),
      threads: row.ThreadCount ?? null,
      handles: row.HandleCount ?? null,
      // Win32_Process reports kernel and user time in 100 ns units.
      cpuSeconds: ticks === null || Number.isNaN(ticks) ? null : Math.round(ticks / 1e5) / 100
    };
  });
}

async function listWindows(processName: string): Promise<CosProcess[]> {
  const name = processName.replace(/'/g, "''");
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$rows = @(Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object {`,
    '  [pscustomobject]@{',
    '    ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId;',
    '    ExecutablePath = $_.ExecutablePath; CommandLine = $_.CommandLine;',
    "    CreationDate = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null };",
    '    WorkingSetSize = [string]$_.WorkingSetSize; ThreadCount = $_.ThreadCount; HandleCount = $_.HandleCount;',
    '    CpuTicks = [string]($_.KernelModeTime + $_.UserModeTime)',
    '  } })',
    'if ($rows.Count -gt 0) { ConvertTo-Json -InputObject $rows -Compress -Depth 3 }'
  ].join('\n');
  const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  return parseCimJson(stdout);
}

/** Best effort outside Windows: `ps` has no parent-independent way to name Electron's helpers. */
async function listPosix(processName: string): Promise<CosProcess[]> {
  const stdout = await run('ps', ['-axo', 'pid=,ppid=,command=']);
  const found: CosProcess[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || !match[3]!.includes(processName)) continue;
    const commandLine = match[3]!;
    found.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      exe: null,
      commandLine,
      startedAt: null,
      main: isMainCommandLine(commandLine),
      workingSetBytes: null,
      threads: null,
      handles: null,
      cpuSeconds: null
    });
  }
  return found;
}

export function listCosProcesses(env: CosEnv): Promise<CosProcess[]> {
  return env.platform === 'win32' ? listWindows(env.processName) : listPosix(env.processName);
}

/** The main process is the one without `--type=`; the oldest wins if an updater briefly overlaps two. */
export function pickMain(processes: CosProcess[]): CosProcess | null {
  const mains = processes.filter((item) => item.main);
  if (!mains.length) return null;
  return mains.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))[0] ?? null;
}

export async function killTree(env: CosEnv, pid: number): Promise<void> {
  if (env.platform === 'win32') {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch((error: Error & { code?: number }) => {
      // 128: the process already ended between the listing and the kill.
      if (error.code !== 128) throw error;
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Starts the app detached from this MCP process, so it outlives the agent session.
 * `--background` is the app's own flag for starting to the tray without showing the window.
 */
export function launch(exe: string): number | null {
  const env = { ...process.env };
  // cos-mcp may itself run under the app's executable in Node mode; the app must not inherit that.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const child = spawn(exe, ['--background'], {
    cwd: path.dirname(exe),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env
  });
  child.on('error', () => undefined);
  child.unref();
  return child.pid ?? null;
}
