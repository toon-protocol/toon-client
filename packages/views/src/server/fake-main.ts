#!/usr/bin/env node
/**
 * Runnable fake TOON apps MCP server (stdio).
 *
 * Demonstrates the agent-driven generative-UI loop end-to-end with NO core/sdk:
 * reads come from a seeded in-memory relay, writes are faked (and reflected on
 * the next read). Point an MCP host at it:
 *
 *   pnpm --filter @toon-protocol/views build && pnpm --filter @toon-protocol/views build:app
 *   node packages/views/dist/server/fake-main.js
 *
 * Then connect it as an MCP server (e.g. `claude mcp add toon-fake -- node …/fake-main.js`).
 */

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerToonApps } from './apps-server.js';
import { FakeBackend } from './fake-backend.js';

function loadAppHtml(): string {
  // Compiled to dist/server/fake-main.js; the bundle is at dist/app/index.html.
  try {
    return readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  } catch {
    return '<!doctype html><html><body><div id="root">toon app bundle not built — run `pnpm --filter @toon-protocol/views build:app`</div></body></html>';
  }
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'toon-fake', version: '0.1.0' });
  registerToonApps(server, { backend: new FakeBackend(), appHtml: loadAppHtml() });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr.
  console.error('[toon-fake] ready (fake reads + fake writes)');
}

main().catch((err) => {
  console.error('[toon-fake]', err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
