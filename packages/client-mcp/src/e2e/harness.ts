/**
 * Claude Agent SDK e2e harness for the `toon-mcp` stdio server.
 *
 * `toon-mcp` is a stdio MCP server (bin `toon-mcp` → `dist/mcp.js`). On startup
 * it AUTO-SPAWNS the `toon-clientd` daemon detached and proxies every tool call
 * to the daemon's Fastify control plane over HTTP. So this harness does NOT
 * spawn two processes itself — it points the Claude Agent SDK at the single
 * `toon-mcp` stdio command, and `toon-mcp` brings the daemon up.
 *
 * Isolation: each run gets a fresh temp `TOON_CLIENT_HOME` (the daemon's PID
 * lock, channel store and `daemon.log` all live under it) and a free
 * `TOON_CLIENT_HTTP_PORT` so parallel/repeat runs never collide on the default
 * 8787.
 *
 * The Agent SDK is LLM-DRIVEN via `query({ prompt, options })`; it is not a
 * low-level MCP client and exposes no direct `listTools()` / `callTool()`. So:
 *   • tools are DISCOVERED from the `system`/`init` message
 *     (`message.mcp_servers` + `message.tools`, names `mcp__toon__*`);
 *   • a tool is CALLED only indirectly — by prompting the agent and gating with
 *     `allowedTools: ['mcp__toon__*']`, then observing the assistant
 *     `tool_use` block and the final `result` message.
 *
 * This harness is read-only / chain-free: it drives only the no-funds tools
 * (e.g. `toon_channels`). The daemon may stay "bootstrapping" with a dummy BTP
 * URL — that is fine for the read-only control-plane tools.
 */

import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readPid } from '../daemon/lifecycle.js';

/** Dev test mnemonic used elsewhere in this package (config/first-run tests). */
export const DEV_MNEMONIC =
  'test test test test test test test test test test test junk';

export interface DaemonHarnessOpts {
  /** BIP-39 mnemonic for the daemon identity. Default: the dev "…junk" mnemonic. */
  mnemonic?: string;
  /**
   * BTP WebSocket URL. `resolveConfig` REQUIRES one, but for read-only tools the
   * daemon may stay bootstrapping against it. Default: a dummy `ws://` URL.
   */
  btpUrl?: string;
  /** Town relay WS URL for free reads. Default: `ws://localhost:7100`. */
  relayUrl?: string;
  /** Control-plane HTTP port. Default: a free port picked by the harness. */
  httpPort?: number;
  /** Isolated config home. Default: `mkdtempSync(tmpdir(), 'toon-mcp-e2e-')`. */
  home?: string;
  /** Path to the built `dist/mcp.js`. Default: resolved next to this package. */
  mcpEntry?: string;
  /** Extra env merged into the `toon-mcp` process env. */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface DaemonHarness {
  /** Ready to spread into the Agent SDK `options.mcpServers`. */
  mcpServerConfig: Record<
    string,
    { command: string; args: string[]; env: NodeJS.ProcessEnv }
  >;
  /** The isolated `TOON_CLIENT_HOME` for this run. */
  home: string;
  /** The free control-plane port handed to the daemon. */
  httpPort: number;
  /**
   * Runs a no-op query, returning the `mcp__toon__*` tool names the agent sees
   * from the `system`/`init` message. Asserts the `toon` server reports
   * `status: 'connected'`.
   */
  listTools(): Promise<string[]>;
  /**
   * Drives the agent to call a READ-ONLY tool (by its bare name, e.g.
   * `toon_channels`). Returns whether a matching `mcp__toon__*` `tool_use`
   * fired and the final result text (the run must reach
   * `result.subtype === 'success'`).
   */
  callReadOnlyTool(
    name: string,
    prompt?: string
  ): Promise<{ called: boolean; result: string }>;
  /** SIGTERM the auto-spawned daemon (via `<home>/daemon.pid`) and rm the temp home. */
  stop(): Promise<void>;
}

const SERVER_NAME = 'toon';

/** Bind to 127.0.0.1:0, read the assigned port, release it. (Small TOCTOU window.) */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Resolve the built `dist/mcp.js` (the `toon-mcp` bin entry) next to this package. */
function defaultMcpEntry(): string {
  // This module builds to `dist/e2e/harness.js`; `dist/mcp.js` is two dirs up.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'mcp.js');
}

/** Drop undefined values so the SDK gets a clean `Record<string, string>`. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export async function startDaemonHarness(
  opts: DaemonHarnessOpts = {}
): Promise<DaemonHarness> {
  const mnemonic = opts.mnemonic ?? DEV_MNEMONIC;
  const btpUrl = opts.btpUrl ?? 'ws://127.0.0.1:9/btp';
  const relayUrl = opts.relayUrl ?? 'ws://localhost:7100';
  const httpPort = opts.httpPort ?? (await pickFreePort());
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'toon-mcp-e2e-'));
  const mcpEntry = opts.mcpEntry ?? defaultMcpEntry();

  // Env handed to the `toon-mcp` process (which forwards it to the detached
  // daemon it spawns). Inherit the parent env so the Claude credential
  // (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) and PATH flow through.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TOON_CLIENT_HOME: home,
    TOON_CLIENT_MNEMONIC: mnemonic,
    TOON_CLIENT_BTP_URL: btpUrl,
    TOON_CLIENT_RELAY_URL: relayUrl,
    TOON_CLIENT_HTTP_PORT: String(httpPort),
    ...opts.extraEnv,
  };

  const mcpServerConfig = {
    [SERVER_NAME]: { command: process.execPath, args: [mcpEntry], env },
  };

  /** Shared Agent SDK options pointing at the isolated `toon-mcp` server. */
  function baseOptions() {
    return {
      mcpServers: {
        [SERVER_NAME]: {
          type: 'stdio' as const,
          command: process.execPath,
          args: [mcpEntry],
          env: stringEnv(env),
          // Force the tools into the prompt and block startup until connected so
          // the init message reliably reports them.
          alwaysLoad: true,
        },
      },
      allowedTools: [`mcp__${SERVER_NAME}__*`],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      maxTurns: 6,
    };
  }

  async function listTools(): Promise<string[]> {
    const controller = new AbortController();
    const q = query({
      // A trivial prompt; we only need the init message, then we close.
      prompt: 'List your available tools, then stop.',
      options: { ...baseOptions(), abortController: controller },
    });
    try {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') {
          const server = message.mcp_servers.find(
            (s) => s.name === SERVER_NAME
          );
          if (!server) {
            throw new Error(
              `MCP server "${SERVER_NAME}" not present in init message`
            );
          }
          if (server.status !== 'connected') {
            throw new Error(
              `MCP server "${SERVER_NAME}" status is "${server.status}", expected "connected"`
            );
          }
          return message.tools.filter((t) =>
            t.startsWith(`mcp__${SERVER_NAME}__`)
          );
        }
      }
    } finally {
      q.close();
    }
    throw new Error('No system/init message received from the Agent SDK');
  }

  async function callReadOnlyTool(
    name: string,
    prompt?: string
  ): Promise<{ called: boolean; result: string }> {
    const toolName = `mcp__${SERVER_NAME}__${name}`;
    const ask =
      prompt ??
      `Call the ${toolName} tool exactly once with no arguments, then briefly report what it returned. Do not call any other tool.`;
    const controller = new AbortController();
    const q = query({
      prompt: ask,
      options: { ...baseOptions(), abortController: controller },
    });
    let called = false;
    let result = '';
    try {
      for await (const message of q) {
        if (message.type === 'assistant') {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block.type === 'tool_use' &&
                typeof block.name === 'string' &&
                block.name.startsWith(`mcp__${SERVER_NAME}__`)
              ) {
                called = true;
              }
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success') {
            result = message.result;
          } else {
            throw new Error(
              `Agent run did not succeed: result.subtype="${message.subtype}"`
            );
          }
        }
      }
    } finally {
      q.close();
    }
    return { called, result };
  }

  async function stop(): Promise<void> {
    // The `toon-mcp` process itself exits with the SDK subprocess; the detached
    // daemon it spawned does NOT — SIGTERM it via the PID lock under `home`
    // (mirrors `daemon stop`), then remove the temp home.
    const pid = readPid(join(home, 'daemon.pid'));
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    rmSync(home, { recursive: true, force: true });
  }

  return { mcpServerConfig, home, httpPort, listTools, callReadOnlyTool, stop };
}
