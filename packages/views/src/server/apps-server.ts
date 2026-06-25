/**
 * Registers the TOON apps surface on an MCP server: the single `ui://toon/app`
 * UI resource plus the tools the agent uses to drive a generative user journey.
 *
 * The journey loop:
 *   1. agent → `toon_atoms`  (discover the atom vocabulary)
 *   2. agent → `toon_render(spec)`  (compose a ViewSpec; rides back as the tool
 *      result, and the tool's `_meta.ui.resourceUri` makes the host render the
 *      app bundle with it)
 *   3. iframe → `toon_query(filter)`  (free reads, fed into atoms)
 *   4. iframe → `toon_publish_unsigned` / `toon_upload_media`  (writes)
 *   5. iframe → updateModelContext → agent composes the next ViewSpec
 *
 * ViewSpecs are model-authored → validated here (server side) before they are
 * echoed back, in addition to the iframe runtime's own validation.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';
import { ATOM_CATALOG, CATALOG_ATOM_IDS } from '../catalog.js';
import { EXAMPLE_VIEWSPECS } from '../examples.js';
import { validateViewSpec } from '../spec.js';
import { type NostrFilter } from '../types.js';
import {
  APP_RESOURCE_URI,
  ATOMS_TOOL,
  OPEN_CHANNEL_TOOL,
  PUBLISH_TOOL,
  QUERY_TOOL,
  RENDER_TOOL,
  STATUS_TOOL,
  SWAP_TOOL,
  UPLOAD_TOOL,
  WRITE_TOOLS,
} from '../tool-names.js';
import { type AppBackend, type SwapRequest } from './backend.js';

export interface RegisterToonAppsOptions {
  /** Read/write backend (fake for the demo; real daemon later). */
  backend: AppBackend;
  /** The self-contained app bundle HTML (served as the `ui://toon/app` resource). */
  appHtml: string;
  /** Domains to allow in the iframe CSP (Arweave gateway, relay origin, …). */
  cspDomains?: { connect?: string[]; resource?: string[] };
}

function result(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Register the `ui://toon/app` resource + the generative-UI tools. */
export function registerToonApps(server: McpServer, opts: RegisterToonAppsOptions): void {
  // Default the sandboxed-app CSP to the full gateway preference list so media
  // served from the primary (ar.io) and its fallbacks all load. A single
  // gateway here would block the others the render path fails over to.
  const connect = opts.cspDomains?.connect ?? [...ARWEAVE_GATEWAYS];
  const resource = opts.cspDomains?.resource ?? [...ARWEAVE_GATEWAYS];

  registerAppResource(
    server,
    'TOON',
    APP_RESOURCE_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { csp: { connectDomains: connect, resourceDomains: resource } } },
    },
    (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: opts.appHtml }],
    })
  );

  // toon_atoms — the vocabulary the agent composes with.
  server.registerTool(
    ATOMS_TOOL,
    {
      description:
        'List the atom vocabulary (ids, kinds rendered, props, write actions) plus ' +
        'example ViewSpecs, for composing a view to pass to ' + RENDER_TOOL + '.',
      inputSchema: {},
    },
    () => {
      const atomsPayload = { atoms: ATOM_CATALOG, examples: EXAMPLE_VIEWSPECS };
      return result(JSON.stringify(atomsPayload, null, 2), atomsPayload);
    }
  );

  // toon_render — agent composes a ViewSpec; it rides back as the tool result and
  // the host renders the app bundle (via _meta.ui.resourceUri) with it.
  registerAppTool(
    server,
    RENDER_TOOL,
    {
      description:
        'Render an agent-authored ViewSpec (a tree of atoms with data binds and ' +
        'write actions) as the in-host UI. Use ' + ATOMS_TOOL + ' to learn the vocabulary.',
      inputSchema: { spec: z.unknown() },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    (args: { spec: unknown }) => {
      const check = validateViewSpec(args.spec, {
        allowedAtoms: CATALOG_ATOM_IDS,
        allowedTools: WRITE_TOOLS,
      });
      if (!check.ok) {
        return errorResult(`Invalid ViewSpec:\n- ${check.errors.join('\n- ')}`);
      }
      return result(`Rendering view${check.spec.title ? `: ${check.spec.title}` : ''}.`, {
        viewSpec: check.spec,
      });
    }
  );

  // toon_query — free reads resolved from the backend.
  server.registerTool(
    QUERY_TOOL,
    {
      description: 'Free read: resolve a NIP-01 filter to matching events.',
      inputSchema: { filter: z.record(z.unknown()) },
    },
    async (args: { filter: Record<string, unknown> }) => {
      const events = await opts.backend.query(args.filter as NostrFilter);
      return result(`${events.length} event(s).`, { events });
    }
  );

  // toon_status — free read: the current pay-to-write fee + settlement chain.
  // The confirm UX pulls the fee from here (never hardcoded); when the real
  // daemon backend (#16) is wired, the same UI shows the live fee/chain.
  server.registerTool(
    STATUS_TOOL,
    {
      description:
        'Free read: report the current pay-to-write fee (feePerEvent) and ' +
        'settlement chain. Used by the confirm UX to show the fee being paid.',
      inputSchema: {},
    },
    async () => {
      const status = await opts.backend.status();
      return result(
        `Fee ${status.feePerEvent}${status.asset ? ` ${status.asset}` : ''} per event on ${status.settlementChain}.`,
        { ...status }
      );
    }
  );

  // toon_publish_unsigned — write (the daemon/back-end signs; the UI never does).
  server.registerTool(
    PUBLISH_TOOL,
    {
      description:
        'Pay-to-write: supply only { kind, content, tags } — the backend signs ' +
        'with the held key and publishes. UI actions target this tool.',
      inputSchema: {
        kind: z.number(),
        content: z.string().optional(),
        tags: z.array(z.array(z.string())).optional(),
      },
    },
    async (args: { kind: number; content?: string; tags?: string[][] }) => {
      const res = await opts.backend.publish(args);
      return result(`Published event ${res.eventId}.`, { ...res });
    }
  );

  // toon_upload_media — spendy two-step write (upload → publish referencing it).
  server.registerTool(
    UPLOAD_TOOL,
    {
      description:
        'Spendy: upload base64 media to Arweave then publish a referencing event ' +
        '(default kind:1063; 20 picture, 21/22 video, 1 note w/ imeta).',
      inputSchema: {
        dataBase64: z.string(),
        mime: z.string().optional(),
        kind: z.number().optional(),
        caption: z.string().optional(),
        tags: z.array(z.array(z.string())).optional(),
      },
    },
    async (args: {
      dataBase64: string;
      mime?: string;
      kind?: number;
      caption?: string;
      tags?: string[][];
    }) => {
      const res = await opts.backend.uploadMedia(args);
      return result(`Uploaded + published media at ${res.url}.`, { ...res });
    }
  );

  // toon_open_channel — pre-open a payment channel (daemon signs/settles).
  server.registerTool(
    OPEN_CHANNEL_TOOL,
    {
      description:
        'Pre-open a payment channel (optionally toward a specific destination). ' +
        'The backend signs/settles; the UI never holds keys. Returns { channelId }.',
      inputSchema: { destination: z.string().optional() },
    },
    async (args: { destination?: string }) => {
      const res = await opts.backend.openChannel(args);
      return result(`Opened channel ${res.channelId}.`, { ...res });
    }
  );

  // toon_swap — spendy cross-asset swap (daemon signs the source claim,
  // returns the signed target-chain claim + settlement metadata).
  server.registerTool(
    SWAP_TOOL,
    {
      description:
        'Spendy: run a cross-asset swap via a mill peer. The backend signs the ' +
        'source-asset claim against the open channel and returns the signed ' +
        'target-chain claim(s) + settlement metadata. UI actions target this tool.',
      inputSchema: {
        destination: z.string(),
        amount: z.string(),
        millPubkey: z.string(),
        pair: z.object({
          from: z.object({
            assetCode: z.string(),
            assetScale: z.number(),
            chain: z.string(),
          }),
          to: z.object({
            assetCode: z.string(),
            assetScale: z.number(),
            chain: z.string(),
          }),
          rate: z.string(),
          minAmount: z.string().optional(),
          maxAmount: z.string().optional(),
        }),
        chainRecipient: z.string(),
        packetCount: z.number().optional(),
      },
    },
    async (args: SwapRequest) => {
      const res = await opts.backend.swap(args);
      return result(
        res.accepted
          ? `Swap ${res.state}: ${res.cumulativeSource} → ${res.cumulativeTarget} (${res.packetsAccepted} packet(s)).`
          : `Swap ${res.state}${res.message ? `: ${res.message}` : ''}.`,
        { ...res }
      );
    }
  );
}
