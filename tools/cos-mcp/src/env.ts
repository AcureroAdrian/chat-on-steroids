import os from 'node:os';
import path from 'node:path';

/**
 * Where Chat On Steroids lives on this machine, and where cos-mcp keeps its own state.
 *
 * Every value can be overridden by an environment variable so tests (and unusual installs) never
 * have to touch the real app. The bridge port range mirrors the app's own `CLF_BRIDGE_PORTS`
 * override, so a machine that moved the bridge is probed where the bridge actually is.
 */
export interface CosEnv {
  platform: NodeJS.Platform;
  /** The app's Electron userData folder: app.log, sessions/, state/, config.json. */
  userDataDir: string;
  /** cos-mcp's own folder: state.json, journal.jsonl, incidents/. Never inside userData. */
  homeDir: string;
  /** Loopback ports where the app's browser bridge may listen. */
  bridgePorts: number[];
  /** Process image name of the app's executable. */
  processName: string;
  /** Executable to start when none was seen running yet. */
  defaultExe: string | null;
}

const DEFAULT_BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769];

export function parsePorts(value: string | undefined): number[] | null {
  if (!value || !value.trim()) return null;
  const ports = new Set<number>();
  for (const part of value.split(',')) {
    const [from, to] = part.trim().split('-').map((item) => Number(item));
    if (from === undefined || !Number.isInteger(from)) continue;
    const last = to !== undefined && Number.isInteger(to) ? to : from;
    for (let port = from; port <= last && port - from < 64; port += 1) {
      if (port > 0 && port < 65536) ports.add(port);
    }
  }
  return ports.size ? [...ports] : null;
}

export function resolveEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CosEnv {
  const home = os.homedir();
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  const defaults =
    platform === 'win32'
      ? {
          userDataDir: path.join(appData, 'chat-on-steroids'),
          homeDir: path.join(localAppData, 'cos-mcp'),
          processName: 'Chat On Steroids.exe',
          defaultExe: path.join(localAppData, 'Programs', 'Chat On Steroids', 'Chat On Steroids.exe')
        }
      : platform === 'darwin'
        ? {
            userDataDir: path.join(home, 'Library', 'Application Support', 'chat-on-steroids'),
            homeDir: path.join(home, 'Library', 'Application Support', 'cos-mcp'),
            processName: 'Chat On Steroids',
            defaultExe: '/Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids'
          }
        : {
            userDataDir: path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'chat-on-steroids'),
            homeDir: path.join(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'cos-mcp'),
            processName: 'chat-on-steroids',
            defaultExe: null
          };

  return {
    platform,
    userDataDir: env.COS_USER_DATA || defaults.userDataDir,
    homeDir: env.COS_MCP_HOME || defaults.homeDir,
    bridgePorts: parsePorts(env.COS_BRIDGE_PORTS) ?? parsePorts(env.CLF_BRIDGE_PORTS) ?? DEFAULT_BRIDGE_PORTS,
    processName: env.COS_PROCESS_NAME || defaults.processName,
    defaultExe: env.COS_EXE || defaults.defaultExe
  };
}
