#!/usr/bin/env node
/**
 * `toon-mcp` — a thin MCP stdio server exposing the TOON client to a Claude
 * agent (Desktop or Code). It holds NO chain keys and NO long-lived
 * connections: every tool maps to an HTTP call against the always-on
 * `toon-clientd` daemon, which it auto-spawns (detached) if it is not running.
 *
 * Works on both surfaces:
 *   • Claude Desktop — `claude_desktop_config.json` mcpServers entry.
 *   • Claude Code   — `claude mcp add toon -- toon-mcp`  (or `.mcp.json`).
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { APP_RESOURCE_URI } from '@toon-protocol/views';
import { ControlClient } from './control-client.js';
import { dispatchTool, TOOL_DEFINITIONS } from './mcp-tools.js';

/** MIME marking the bundle as an MCP-app UI resource (ext-apps profile). */
const APP_MIME = 'text/html;profile=mcp-app';

/** Load the prebuilt single-file MCP-app bundle served as `ui://toon/app`. */
function loadAppHtml(): string {
  // 1. Prefer the copy shipped next to the built server (tsup onSuccess copies
  //    it into dist/app). This is what a published client-mcp serves — no
  //    dependency on the unpublished @toon-protocol/views package at runtime.
  try {
    return readFileSync(new URL('./app/index.html', import.meta.url), 'utf8');
  } catch {
    /* running from source / not yet copied — fall through to the dev resolve */
  }
  // 2. Dev fallback: resolve the bundle from the @toon-protocol/views workspace.
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve('@toon-protocol/views'); // …/views/dist/index.js
    return readFileSync(join(dirname(entry), 'app', 'index.html'), 'utf8');
  } catch {
    return '<!doctype html><html><body><div id="root">toon app bundle missing — run `pnpm --filter @toon-protocol/views build`</div></body></html>';
  }
}
import { defaultConfigPath, readConfigFile } from './daemon/config.js';
import {
  isDaemonRunning,
  spawnDaemonDetached,
  waitForReady,
} from './daemon/lifecycle.js';

/** stdout carries the MCP protocol — all logging must go to stderr. */
function log(msg: string): void {
  console.error(`[toon-mcp] ${msg}`);
}

/** Resolve the daemon control-plane URL without needing the mnemonic. */
function controlPlaneUrl(): string {
  const file = readConfigFile(
    process.env['TOON_CLIENT_CONFIG'] ?? defaultConfigPath()
  );
  const port = Number(
    process.env['TOON_CLIENT_HTTP_PORT'] ?? file.httpPort ?? 8787
  );
  return `http://127.0.0.1:${port}`;
}

/**
 * Make sure the daemon is up: if the lock shows it running, return; otherwise
 * spawn it detached and wait until the control plane is reachable. Best-effort
 * — failures surface as readable tool errors rather than crashing the server.
 */
async function ensureDaemon(url: string): Promise<void> {
  if (isDaemonRunning()) return;
  const client = new ControlClient({ baseUrl: url });
  if (await client.ping()) return;
  log('daemon not running — spawning detached');
  try {
    const pid = spawnDaemonDetached();
    log(`spawned toon-clientd (pid ${pid}); waiting for control plane`);
    await waitForReady(url, 20_000);
  } catch (err) {
    log(
      `failed to spawn daemon: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function main(): Promise<void> {
  const url = controlPlaneUrl();
  const control = new ControlClient({ baseUrl: url });

  // Kick off daemon startup; don't block server init on it (anon bootstrap is
  // slow). Tools report "bootstrapping — retry" until it is ready.
  void ensureDaemon(url);

  const server = new Server(
    { name: 'toon-client', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  const appHtml = loadAppHtml();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // The MCP-app UI resource the host renders for toon_render results.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: APP_RESOURCE_URI, name: 'TOON', mimeType: APP_MIME },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== APP_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [{ uri: APP_RESOURCE_URI, mimeType: APP_MIME, text: appHtml }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // If the daemon went away, try once to bring it back before dispatching.
    if (!(await control.ping())) await ensureDaemon(url);
    // Our ToolResult is a structural subset of CallToolResult (content + isError);
    // the SDK's handler union also carries a task-augmented variant we never use.
    return (await dispatchTool(control, name, args)) as CallToolResult;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready; proxying to ${url}`);
}

main().catch((err) => {
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
