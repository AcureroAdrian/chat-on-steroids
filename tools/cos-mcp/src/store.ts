import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * cos-mcp's own memory between calls and between agent sessions.
 *
 * It lives in its own folder, never in the app's userData: this process only reads the app.
 */
export interface ControlAction {
  at: string;
  kind: 'start' | 'stop' | 'restart';
  userRequested: boolean;
}

export interface McpState {
  /** Last time the app answered, and which process answered. */
  lastResponsive: { pid: number; at: string } | null;
  /** First time the current process was seen not answering. */
  unresponsiveSince: { pid: number; at: string } | null;
  /** Executable path of the last app process seen running. */
  lastExe: string | null;
  /** Set by cos_stop so the next check reports a deliberate stop instead of a crash. */
  stoppedByAgent: { at: string; reason: string; userRequested: boolean } | null;
  recentActions: ControlAction[];
}

const EMPTY: McpState = { lastResponsive: null, unresponsiveSince: null, lastExe: null, stoppedByAgent: null, recentActions: [] };

export interface JournalEntry {
  at: string;
  tool: string;
  reason: string;
  userRequested: boolean;
  force: boolean;
  before: string;
  after: string | null;
  outcome: 'done' | 'refused' | 'failed' | 'aborted';
  detail: string;
  incident: string | null;
}

export class Store {
  constructor(readonly homeDir: string) {}

  private get statePath() {
    return path.join(this.homeDir, 'state.json');
  }

  private get journalPath() {
    return path.join(this.homeDir, 'journal.jsonl');
  }

  async readState(): Promise<McpState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<McpState>;
      return { ...EMPTY, ...parsed, recentActions: Array.isArray(parsed.recentActions) ? parsed.recentActions : [] };
    } catch {
      return { ...EMPTY };
    }
  }

  async writeState(state: McpState): Promise<void> {
    await mkdir(this.homeDir, { recursive: true });
    const trimmed = { ...state, recentActions: state.recentActions.slice(-50) };
    const temp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(trimmed, null, 2));
    await rename(temp, this.statePath);
  }

  async updateState(change: (state: McpState) => McpState | void): Promise<McpState> {
    const state = await this.readState();
    const next = change(state) ?? state;
    await this.writeState(next);
    return next;
  }

  async appendJournal(entry: JournalEntry): Promise<void> {
    await mkdir(this.homeDir, { recursive: true });
    await appendFile(this.journalPath, JSON.stringify(entry) + '\n');
  }

  async readJournal(limit: number): Promise<JournalEntry[]> {
    let text = '';
    try {
      text = await readFile(this.journalPath, 'utf8');
    } catch {
      return [];
    }
    const entries: JournalEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A line cut short by a crash is skipped, not fatal.
      }
    }
    return entries.slice(-limit);
  }

  /** Writes an evidence bundle and returns its folder name. */
  async writeIncident(kind: string, files: Record<string, string>): Promise<string> {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}`;
    const dir = path.join(this.homeDir, 'incidents', id);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
    return id;
  }

  incidentPath(id: string): string {
    return path.join(this.homeDir, 'incidents', id);
  }
}
