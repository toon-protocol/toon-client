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
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';
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

  // Kick off daemon startup; don't block server init on it (BTP bootstrap can
  // take a moment). Tools report "bootstrapping — retry" until it is ready.
  void ensureDaemon(url);

  const server = new Server(
    { name: 'toon-client', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      // Travels to EVERY host in the `initialize` result (incl. claude.ai chat,
      // which never loads the Claude Code skill). Keep the render-first policy
      // here so it governs all surfaces, not just Claude Code.
      instructions:
        'TOON is pay-to-write Nostr over Interledger; reads are free, writes ' +
        'are paid. RENDERING IS THE DEFAULT SURFACE: when the user asks to ' +
        'see/show/open/view/browse/render TOON events, profiles, feeds, ' +
        'threads, channels, or balances, call toon_atoms then toon_render ' +
        '(ui://toon/app) — do NOT route TOON data to a generic ' +
        'HTML/SVG/chart/widget tool or dump it as text. Always call toon_atoms ' +
        'before toon_render. The rendered card IS the response: for read-only ' +
        'views (feeds, profiles, threads, channels, balances, wallet) go ' +
        'STRAIGHT toon_atoms → toon_render — do NOT precede a render with ' +
        'daemon-health (toon_status), identity (toon_identity), or balance ' +
        'preflight, and do NOT narrate the tool calls or write a status ' +
        'report; at most a one-line caption after. On ANY intent to upload ' +
        'media or post/publish a ' +
        'picture/video/image (e.g. "I want to upload", "publish an image", ' +
        '"post a photo"), your FIRST action is toon_atoms then toon_render with ' +
        'the media view (media-uploader atom). The uploader has an in-app FILE ' +
        'PICKER, so do NOT ask whether a file is attached, where the image is, ' +
        'or for a URL, and do NOT recount upload-path history or known issues — ' +
        'just render the uploader and let the user pick a file. Writes ' +
        '(post/like/follow/upload/swap) spend a ' +
        'payment-channel claim; surface the fee and confirm before paying. ' +
        'When rendering, the trusted host shows the pay/consent surface. When ' +
        'you CANNOT render (a text-only host), you MUST first call toon_status ' +
        'to quote the exact fee + asset, tell the user the fee and that the ' +
        'write is permanent and non-refundable (events cannot be unpublished), ' +
        'and get explicit confirmation before calling any paid write ' +
        '(toon_publish, toon_publish_unsigned, toon_upload, toon_swap). ' +
        'Fall back to text only on explicit request or render failure.',
    }
  );

  const appHtml = loadAppHtml();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // The MCP-app UI resource the host renders for toon_render results.
  //
  // CSP: the rendered feed/uploader shows media stored on Arweave. Without an
  // explicit `resourceDomains`, the host iframe's default `img-src`/`media-src`
  // blocks those gateways and images never load (toon-client#127). Advertise the
  // Arweave gateways as both resource (img/media/static) and connect origins.
  // Per the ext-apps spec the host reads `_meta.ui.csp` from the `resources/read`
  // content item, with the `resources/list` entry as fallback — so set it on both.
  //
  // CRUCIAL: ar.io / arweave.net gateways serve a 302 from the apex
  // (`https://arweave.net/<txId>`) to a per-tx SANDBOX SUBDOMAIN
  // (`https://<base32>.arweave.net/<txId>`). CSP `img-src` is checked against the
  // REDIRECT TARGET, so an apex-only allowlist still blocks the image. Allow both
  // the apex (initial request) and a wildcard subdomain (where the bytes load).
  const arweaveCspDomains = ARWEAVE_GATEWAYS.flatMap((gateway) => {
    try {
      const host = new URL(gateway).host;
      return [gateway, `https://*.${host}`];
    } catch {
      return [gateway];
    }
  });
  const APP_CSP = {
    csp: {
      resourceDomains: arweaveCspDomains,
      connectDomains: arweaveCspDomains,
    },
  };

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: APP_RESOURCE_URI, name: 'TOON', mimeType: APP_MIME, _meta: { ui: APP_CSP } },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== APP_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [
        { uri: APP_RESOURCE_URI, mimeType: APP_MIME, text: appHtml, _meta: { ui: APP_CSP } },
      ],
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
