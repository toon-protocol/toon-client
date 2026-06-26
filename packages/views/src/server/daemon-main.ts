#!/usr/bin/env node
/**
 * Real TOON apps MCP server (stdio) — the daemon-backed counterpart to
 * {@link ./fake-main fake-main.ts}.
 *
 * Reads resolve over the free Nostr relay side and writes go through the
 * always-on `toon-clientd` control plane: this entrypoint wires a
 * {@link DaemonAppBackend} (over a tiny fetch-based {@link DaemonControl}) into
 * {@link ./apps-server.registerToonApps registerToonApps}. No chain keys ever
 * live in this process or the iframe — the daemon holds the key and signs+pays.
 *
 *   pnpm --filter @toon-protocol/views build
 *   node packages/views/dist/server/daemon-main.js   # toon-clientd must be up
 *
 * Then connect it as an MCP server (e.g. `claude mcp add toon -- node …/daemon-main.js`).
 *
 * The daemon URL is resolved the same way `client-mcp/src/mcp.ts` does — from
 * `TOON_CLIENT_HTTP_PORT` or the config file's `httpPort`, default 8787. To keep
 * `@toon-protocol/views` free of a dependency cycle on `@toon-protocol/client-mcp`
 * (which imports views), this entrypoint speaks the control plane over `fetch`
 * directly rather than importing the client-mcp `ControlClient` — the structural
 * `DaemonControl` port is all `DaemonAppBackend` needs.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerToonApps } from './apps-server.js';
import {
  DaemonAppBackend,
  type DaemonBalancesResponse,
  type DaemonChannelsResponse,
  type DaemonControl,
  type DaemonFundWalletResponse,
  type DaemonPublishResponse,
  type DaemonPublishUnsignedRequest,
  type DaemonQueryRequest,
  type DaemonQueryResponse,
  type DaemonStatusResponse,
  type DaemonUploadMediaRequest,
  type DaemonUploadMediaResponse,
} from './daemon-backend.js';
import {
  type ChannelCloseView,
  type ChannelDepositView,
  type ChannelSettleView,
  type SwapRequest,
  type SwapResponse,
} from './backend.js';

function loadAppHtml(): string {
  // Compiled to dist/server/daemon-main.js; the bundle is at dist/app/index.html.
  try {
    return readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  } catch {
    return '<!doctype html><html><body><div id="root">toon app bundle not built — run `pnpm --filter @toon-protocol/views build`</div></body></html>';
  }
}

/** Default `toon-clientd` config path (mirrors client-mcp's `defaultConfigPath`). */
function defaultConfigPath(): string {
  return join(homedir(), '.config', 'toon', 'client.json');
}

/**
 * Resolve the daemon control-plane URL without needing the mnemonic — the same
 * precedence `client-mcp/src/mcp.ts` uses: `TOON_CLIENT_HTTP_PORT`, then the
 * config file's `httpPort`, default 8787.
 */
function controlPlaneUrl(): string {
  let filePort: number | undefined;
  const configPath = process.env['TOON_CLIENT_CONFIG'] ?? defaultConfigPath();
  try {
    const file = JSON.parse(readFileSync(configPath, 'utf8')) as {
      httpPort?: number;
    };
    filePort = file.httpPort;
  } catch {
    /* no/unreadable config — fall back to env / default */
  }
  const port = Number(process.env['TOON_CLIENT_HTTP_PORT'] ?? filePort ?? 8787);
  return `http://127.0.0.1:${port}`;
}

/** Thrown when the daemon control plane is unreachable. */
class DaemonUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly causedBy?: unknown
  ) {
    super(`toon-clientd not reachable at ${baseUrl}`);
    this.name = 'DaemonUnreachableError';
  }
}

/**
 * A minimal fetch-based {@link DaemonControl} over the daemon HTTP control plane
 * (`POST /query`, `/publish-unsigned`, `/upload-media`). This is a deliberately
 * tiny subset of client-mcp's `ControlClient`; the production `toon-mcp` server
 * uses the full client (see the §3 reconciliation note in the PR).
 */
function makeControl(baseUrl: string): DaemonControl {
  const root = baseUrl.replace(/\/+$/, '');
  const timeoutMs = 35_000; // publishes can wait on FULFILL

  async function post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new DaemonUnreachableError(root, err);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; detail?: string };
      throw new Error(
        `${path} failed (HTTP ${res.status}): ${e.error ?? 'unknown'}${
          e.detail ? ` — ${e.detail}` : ''
        }`
      );
    }
    return json as T;
  }

  async function get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, { signal: controller.signal });
    } catch (err) {
      throw new DaemonUnreachableError(root, err);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; detail?: string };
      throw new Error(
        `${path} failed (HTTP ${res.status}): ${e.error ?? 'unknown'}${
          e.detail ? ` — ${e.detail}` : ''
        }`
      );
    }
    return json as T;
  }

  return {
    // GET /status returns the daemon `StatusResponse`; map the fields the
    // confirm UX needs. `settlementChain` is reported directly; `feePerEvent`
    // is the daemon's configured per-event fee (default '1' if not surfaced).
    status: async (): Promise<DaemonStatusResponse> => {
      const s = await get<{
        settlementChain?: string;
        feePerEvent?: string;
        asset?: string;
      }>('/status');
      return {
        feePerEvent: s.feePerEvent ?? '1',
        settlementChain: s.settlementChain ?? 'unknown',
        ...(s.asset ? { asset: s.asset } : {}),
      };
    },
    query: (b: DaemonQueryRequest) =>
      post<DaemonQueryResponse>('/query', b),
    publishUnsigned: (b: DaemonPublishUnsignedRequest) =>
      post<DaemonPublishResponse>('/publish-unsigned', b),
    uploadMedia: (b: DaemonUploadMediaRequest) =>
      post<DaemonUploadMediaResponse>('/upload-media', b),
    openChannel: (b: { destination?: string }) =>
      post<{ channelId: string }>('/channels', b),
    swap: (b: SwapRequest) => post<SwapResponse>('/swap', b),
    channels: () => get<DaemonChannelsResponse>('/channels'),
    balances: () => get<DaemonBalancesResponse>('/balances'),
    fundWallet: (b: { chain?: string; address?: string }) =>
      post<DaemonFundWalletResponse>('/fund-wallet', b),
    depositToChannel: (b: { channelId: string; amount: string }) =>
      post<ChannelDepositView>('/channels/deposit', b),
    closeChannel: (b: { channelId: string }) => post<ChannelCloseView>('/channels/close', b),
    settleChannel: (b: { channelId: string }) => post<ChannelSettleView>('/channels/settle', b),
  };
}

async function main(): Promise<void> {
  const url = controlPlaneUrl();
  const control = makeControl(url);
  const server = new McpServer({ name: 'toon-client', version: '0.1.0' });
  registerToonApps(server, {
    backend: new DaemonAppBackend(control),
    appHtml: loadAppHtml(),
  });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr.
  console.error(`[toon-apps] ready; proxying to ${url}`);
}

main().catch((err) => {
  console.error('[toon-apps]', err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
