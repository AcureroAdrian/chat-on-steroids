#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveEnv } from './env.js';
import { createServer, VERSION } from './server.js';

const args = new Set(process.argv.slice(2));

if (args.has('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (args.has('--help')) {
  process.stdout.write(
    [
      'cos-mcp: stdio MCP server to watch and control Chat On Steroids.',
      '',
      'Usage: cos-mcp [--read-only]',
      '  --read-only   expose only cos_health, cos_logs and cos_journal',
      '',
      'Environment overrides: COS_USER_DATA, COS_MCP_HOME, COS_BRIDGE_PORTS, COS_PROCESS_NAME, COS_EXE, COS_MCP_NO_TOAST=1',
      ''
    ].join('\n')
  );
  process.exit(0);
}

const env = resolveEnv();
const readOnly = args.has('--read-only');

// stdout carries the protocol; anything human-readable goes to stderr.
serveStdio(() => createServer(env, { readOnly }), {
  onerror: (error) => process.stderr.write(`cos-mcp: ${error.message}\n`)
});
