import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logText } from './helpers.js';

/**
 * The built server over real stdio, the way an agent launches it. It points at a temporary
 * userData with a closed bridge port and a process name that cannot exist, so it never sees or
 * touches a real installation.
 */
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let dir: string;
let closedPort: number;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cos-mcp-test-'));
  await writeFile(
    path.join(dir, 'app.log'),
    logText([
      ['2026-09-28T02:21:03.967Z', 'info', 'app started'],
      ['2026-09-28T06:14:55.649Z', 'info', 'shutdown sequence complete']
    ])
  );
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  closedPort = (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect(args: string[] = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    env: {
      ...(process.env as Record<string, string>),
      COS_USER_DATA: dir,
      COS_MCP_HOME: path.join(dir, 'home'),
      COS_BRIDGE_PORTS: String(closedPort),
      COS_PROCESS_NAME: 'cos-mcp-test-no-such-process.exe',
      COS_EXE: path.join(dir, 'missing.exe'),
      COS_MCP_NO_TOAST: '1'
    }
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

function parse(result: Awaited<ReturnType<Client['callTool']>>): any {
  const first = (result.content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(first!.text);
}

describe('cos-mcp over stdio', () => {
  it('exposes read tools only in --read-only mode', async () => {
    const client = await connect(['--read-only']);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['cos_health', 'cos_journal', 'cos_logs']);
    await client.close();
  });

  it('reports a deliberate close, refuses to override it, and journals the refusal', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['cos_health', 'cos_journal', 'cos_logs', 'cos_restart', 'cos_start', 'cos_stop']);

    const health = parse(await client.callTool({ name: 'cos_health', arguments: {} }));
    expect(health).toMatchObject({ state: 'stopped_by_user', suggestedAction: 'none', process: null, responding: null });

    const refused = parse(await client.callTool({ name: 'cos_start', arguments: { reason: 'routine check' } }));
    expect(refused).toMatchObject({ outcome: 'refused', before: 'stopped_by_user' });

    const missingExe = parse(await client.callTool({ name: 'cos_start', arguments: { reason: 'user asked to open it', userRequested: true } }));
    expect(missingExe).toMatchObject({ outcome: 'failed' });
    expect(missingExe.message).toMatch(/executable was not found/);

    const journal = parse(await client.callTool({ name: 'cos_journal', arguments: {} }));
    expect(journal.map((item: { outcome: string }) => item.outcome)).toEqual(['refused', 'failed']);

    const logs = await client.callTool({ name: 'cos_logs', arguments: { lines: 1 } });
    expect((logs.content as Array<{ text: string }>)[0]!.text).toMatch(/shutdown sequence complete/);
    await client.close();
  });
});
