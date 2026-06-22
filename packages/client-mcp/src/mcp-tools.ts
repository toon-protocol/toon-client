/**
 * MCP tool definitions + dispatch. The MCP server is a thin proxy: each tool
 * maps to a `toon-clientd` control-plane call. This module is the testable core
 * (no stdio / SDK transport) so the tool→HTTP mapping and the
 * "bootstrapping — retry" handling can be unit-tested directly.
 */

import {
  ATOM_CATALOG,
  CATALOG_ATOM_IDS,
  EXAMPLE_VIEWSPECS,
  WRITE_TOOLS,
  APP_RESOURCE_URI,
  validateViewSpec,
} from '@toon-protocol/views';
import { ControlApiError, DaemonUnreachableError } from './control-client.js';
import type { ControlClient } from './control-client.js';
import type {
  AddApexRequest,
  H402FetchRequest,
  NostrFilter,
  PublishRequest,
  PublishUnsignedRequest,
  SettlementChain,
  SwapRequest,
  UploadMediaRequest,
} from './control-api.js';

/** A JSON-Schema-described MCP tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP-apps metadata, e.g. `{ ui: { resourceUri } }` linking a UI resource. */
  _meta?: Record<string, unknown>;
}

/** MCP tool-call result shape (subset of the SDK's CallToolResult). */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  /** Machine-readable payload the MCP-app iframe reads (events, ViewSpec, …). */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'toon_status',
    description:
      'Report TOON client daemon health: bootstrapping/ready state, transport, ' +
      'relay connection, buffered-event count, and per-chain settlement status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'toon_identity',
    description:
      "Return this client's public identity (Nostr pubkey + EVM/Solana/Mina " +
      'addresses). Never returns private keys.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'toon_publish',
    description:
      'Pay-to-write: publish a fully-signed Nostr event to the TOON network. ' +
      'Signs an off-chain payment-channel claim and forwards it over BTP. ' +
      'Returns the event id, channel id, and the advanced channel nonce.',
    inputSchema: {
      type: 'object',
      properties: {
        event: {
          type: 'object',
          description:
            'A fully-signed Nostr event (must include id, pubkey, sig, kind, ' +
            'created_at, tags, content).',
        },
        destination: {
          type: 'string',
          description:
            'Optional ILP destination override (default: the apex/town).',
        },
        fee: {
          type: 'string',
          description:
            'Optional fee override in base units (default: daemon config).',
        },
        btpUrl: {
          type: 'string',
          description:
            'Which apex (BTP write target) to publish through (default: the ' +
            'config-seeded apex). Use toon_targets to list registered apexes. ' +
            'Writes always go through BTP — never a relay directly.',
        },
      },
      required: ['event'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_publish_unsigned',
    description:
      'Pay-to-write WITHOUT holding a key: supply only the event shell (kind, ' +
      'content, tags) and the daemon signs it with the held Nostr key, signs the ' +
      'payment-channel claim, and forwards over BTP. For replaceable kinds ' +
      '(0 profile, 3 follow list) the daemon merges the latest known tags first. ' +
      'This is the path MCP-app UI actions use so the iframe never signs.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'number', description: 'Event kind (integer 0–65535).' },
        content: { type: 'string', description: 'Event content (default empty).' },
        tags: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Event tags (array of string arrays).',
        },
        destination: { type: 'string', description: 'Optional ILP destination override.' },
        fee: { type: 'string', description: 'Optional fee override (base units).' },
        btpUrl: { type: 'string', description: 'Which apex to publish through (default: config-seeded).' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_upload_media',
    description:
      'Pay-to-write media (SPENDY, two-step): upload base64 bytes to Arweave via ' +
      'the kind:5094 blob-storage DVM, then sign+publish a media event ' +
      '(default kind:1063 NIP-94; 20=picture, 21/22=video, 1=note w/ NIP-92 imeta) ' +
      'referencing the resulting Arweave URL. Single-packet only.',
    inputSchema: {
      type: 'object',
      properties: {
        dataBase64: { type: 'string', description: 'Base64-encoded media bytes.' },
        mime: { type: 'string', description: "MIME type (default 'application/octet-stream')." },
        kind: { type: 'number', description: 'Media event kind (default 1063).' },
        caption: { type: 'string', description: 'Caption/content for the media event.' },
        tags: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Extra tags merged into the published media event.',
        },
        fee: { type: 'string', description: 'Optional fee override (base units).' },
        btpUrl: { type: 'string', description: 'Which apex to publish through (default: config-seeded).' },
      },
      required: ['dataBase64'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_atoms',
    description:
      'List the atom vocabulary (ids, kinds rendered, props, write actions) plus ' +
      'example ViewSpecs, for composing a view to pass to toon_render. This is how ' +
      'you build the user a generative UI for their journey.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'toon_render',
    description:
      'Render an agent-authored ViewSpec (a tree of atoms with data binds and ' +
      'write actions) as the in-host UI. Call toon_atoms first to learn the ' +
      'vocabulary. The ViewSpec is validated; the host renders the app with it.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description: 'A ViewSpec: { title?, root: ViewNode }. See toon_atoms examples.',
        },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
  },
  {
    name: 'toon_query',
    description:
      'Free read for the UI: resolve a NIP-01 filter to matching events ' +
      '(subscribes, waits briefly, returns matches). Used to fill ViewSpec binds.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { description: 'A NIP-01 filter object.' },
        timeoutMs: { type: 'number', description: 'Bounded wait, ms (default 1200).' },
      },
      required: ['filter'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_subscribe',
    description:
      'Free read: register a persistent town-relay subscription with NIP-01 ' +
      'filter(s). Returns a subscription id to drain with toon_read.',
    inputSchema: {
      type: 'object',
      properties: {
        filters: {
          description: 'A NIP-01 filter object or an array of OR-ed filters.',
        },
        subId: { type: 'string', description: 'Optional caller-supplied id.' },
        relayUrl: {
          type: 'string',
          description:
            'Restrict to one relay. Omit to FAN OUT across every registered ' +
            'relay (reads merge into one ordered stream).',
        },
      },
      required: ['filters'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_read',
    description:
      'Free read: drain buffered events newer than a cursor. Pass back the ' +
      'returned cursor to fetch only events received since the last read.',
    inputSchema: {
      type: 'object',
      properties: {
        subId: { type: 'string', description: 'Restrict to one subscription.' },
        cursor: {
          type: 'number',
          description: 'Cursor from a prior toon_read.',
        },
        limit: {
          type: 'number',
          description: 'Max events to return (default 200).',
        },
        relayUrl: {
          type: 'string',
          description: 'Restrict the drain to events from a single relay.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'toon_open_channel',
    description:
      'Open (or return the existing) payment channel for a destination. ' +
      'Channels open lazily on first publish; use this to pre-open.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: {
          type: 'string',
          description: 'ILP destination (default: apex).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'toon_channels',
    description:
      'List tracked payment channels with their nonce watermark and cumulative ' +
      'transferred amount.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'toon_swap',
    description:
      'Pay a mill peer (asset A) to receive asset B plus a signed target-chain ' +
      'claim. Builds the NIP-59 gift-wrapped kind:20032 swap rumor and streams ' +
      'it; the source-asset claim is signed against the open apex channel (the ' +
      'mill must be routed via apexChildPeers). Returns the accumulated, ' +
      'decrypted target-chain claim(s) and settlement metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: {
          type: 'string',
          description: 'Mill peer ILP destination (e.g. g.townhouse.mill).',
        },
        amount: {
          type: 'string',
          description: 'Total source-asset amount to swap, source micro-units.',
        },
        millPubkey: {
          type: 'string',
          description:
            "Mill's 64-char lowercase hex Nostr pubkey (gift-wrap recipient).",
        },
        pair: {
          type: 'object',
          description:
            'The swap pair (from kind:10032 discovery or operator-supplied): ' +
            '{ from:{assetCode,assetScale,chain}, to:{...}, rate, minAmount?, maxAmount? }.',
        },
        chainRecipient: {
          type: 'string',
          description:
            "Sender's payout address on pair.to.chain (EVM 0x-hex / Solana / Mina base58).",
        },
        packetCount: {
          type: 'number',
          description: 'Split the swap into N equal packets (default 1).',
        },
      },
      required: [
        'destination',
        'amount',
        'millPubkey',
        'pair',
        'chainRecipient',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_targets',
    description:
      'List every registered target: relays (read sources, with connection + ' +
      'buffered-event status) and apexes (BTP write targets, with ready/' +
      'channel status). The TOON client is 1-to-many — many apexes to write ' +
      'through, many relays to read from.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'toon_add_relay',
    description:
      'Add a relay READ target at runtime (persisted across restarts). It joins ' +
      'all fan-out reads immediately; `.anyone` hidden-service relays reuse the ' +
      'managed anon read proxy automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        relayUrl: {
          type: 'string',
          description: 'Relay WS URL (ws://host:7100 or a .anyone service).',
        },
      },
      required: ['relayUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_remove_relay',
    description:
      'Remove a relay read target (persisted). The config-seeded default relay ' +
      'cannot be removed.',
    inputSchema: {
      type: 'object',
      properties: {
        relayUrl: { type: 'string', description: 'Relay WS URL to remove.' },
      },
      required: ['relayUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_add_apex',
    description:
      'Add an apex WRITE target at runtime (persisted across restarts). ' +
      'Settlement params are DISCOVERED by reading the apex’s kind:10032 ' +
      'announcement off the given relay — you do not supply chain/settlement ' +
      'details. The relay is added as a read target first if unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        ilpAddress: {
          type: 'string',
          description: 'ILP address of the apex (e.g. g.townhouse.town).',
        },
        relayUrl: {
          type: 'string',
          description: 'Relay to discover the apex’s kind:10032 on.',
        },
        pubkey: {
          type: 'string',
          description:
            'Optional apex Nostr pubkey (64-char hex) to narrow discovery.',
        },
        chain: {
          type: 'string',
          enum: ['evm', 'solana', 'mina'],
          description: 'Preferred settlement chain (default: apex’s first).',
        },
        childPeers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Child peers via this apex’s channel (e.g. ["dvm","mill"]).',
        },
        feePerEvent: {
          type: 'string',
          description: 'Per-write fee override for this apex (base units).',
        },
      },
      required: ['ilpAddress', 'relayUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_remove_apex',
    description:
      'Remove an apex write target by its BTP URL (persisted). The ' +
      'config-seeded default apex cannot be removed.',
    inputSchema: {
      type: 'object',
      properties: {
        btpUrl: {
          type: 'string',
          description: 'BTP URL of the apex to remove (from toon_targets).',
        },
      },
      required: ['btpUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_http_fetch_paid',
    description:
      'Fetch a paid HTTP resource through the TOON client daemon. Dispatches ' +
      'the request via the daemon network access and returns the raw response ' +
      '(status, headers, body). This is an h402-aware shim: it sends the request ' +
      'as-is today; full ILP payment negotiation for HTTP 402 responses is ' +
      'deferred to a future release.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Target URL.',
        },
        method: {
          type: 'string',
          description: 'HTTP method (default GET).',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Request headers as key-value pairs.',
        },
        body: {
          type: 'string',
          description: 'Request body as a plain string.',
        },
        timeout: {
          type: 'number',
          description: 'Per-request timeout, ms (default 30000).',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

/**
 * Dispatch an MCP tool call to the daemon control plane. Always resolves with a
 * `ToolResult` (errors are encoded as `isError: true` text, not thrown, so the
 * agent sees a readable message). A retryable error (daemon still
 * bootstrapping) yields a clear "retry shortly" message.
 */
export async function dispatchTool(
  client: ControlClient,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'toon_status':
        return ok(await client.status());
      case 'toon_identity': {
        const s = await client.status();
        return ok({
          identity: s.identity,
          ready: s.ready,
          bootstrapping: s.bootstrapping,
        });
      }
      case 'toon_publish':
        return ok(await client.publish(args as unknown as PublishRequest));
      case 'toon_publish_unsigned':
        return ok(
          await client.publishUnsigned(args as unknown as PublishUnsignedRequest)
        );
      case 'toon_upload_media':
        return ok(
          await client.uploadMedia(args as unknown as UploadMediaRequest)
        );
      case 'toon_atoms':
        return okStructured('Atom vocabulary + example ViewSpecs.', {
          atoms: ATOM_CATALOG,
          examples: EXAMPLE_VIEWSPECS,
        });
      case 'toon_render': {
        const check = validateViewSpec(args['spec'], {
          allowedAtoms: CATALOG_ATOM_IDS,
          allowedTools: WRITE_TOOLS,
        });
        if (!check.ok) {
          return err(`Invalid ViewSpec:\n- ${check.errors.join('\n- ')}`);
        }
        return okStructured(
          `Rendering view${check.spec.title ? `: ${check.spec.title}` : ''}.`,
          { viewSpec: check.spec }
        );
      }
      case 'toon_query': {
        const res = await client.query({
          filters: args['filter'] as NostrFilter,
          ...(typeof args['timeoutMs'] === 'number'
            ? { timeoutMs: args['timeoutMs'] }
            : {}),
        });
        return okStructured(`${res.events.length} event(s).`, {
          events: res.events,
        });
      }
      case 'toon_subscribe':
        return ok(
          await client.subscribe({
            filters: args['filters'] as NostrFilter | NostrFilter[],
            ...(typeof args['subId'] === 'string'
              ? { subId: args['subId'] }
              : {}),
            ...(typeof args['relayUrl'] === 'string'
              ? { relayUrl: args['relayUrl'] }
              : {}),
          })
        );
      case 'toon_read':
        return ok(
          await client.events({
            ...(typeof args['subId'] === 'string'
              ? { subId: args['subId'] }
              : {}),
            ...(typeof args['cursor'] === 'number'
              ? { cursor: args['cursor'] }
              : {}),
            ...(typeof args['limit'] === 'number'
              ? { limit: args['limit'] }
              : {}),
            ...(typeof args['relayUrl'] === 'string'
              ? { relayUrl: args['relayUrl'] }
              : {}),
          })
        );
      case 'toon_open_channel':
        return ok(
          await client.openChannel(
            typeof args['destination'] === 'string'
              ? { destination: args['destination'] }
              : {}
          )
        );
      case 'toon_channels':
        return ok(await client.channels());
      case 'toon_swap':
        return ok(
          await client.swap({
            destination: String(args['destination']),
            amount: String(args['amount']),
            millPubkey: String(args['millPubkey']),
            pair: args['pair'] as SwapRequest['pair'],
            chainRecipient: String(args['chainRecipient']),
            ...(typeof args['packetCount'] === 'number'
              ? { packetCount: args['packetCount'] }
              : {}),
          })
        );
      case 'toon_targets':
        return ok(await client.targets());
      case 'toon_add_relay':
        return ok(
          await client.addRelay({ relayUrl: String(args['relayUrl']) })
        );
      case 'toon_remove_relay':
        return ok(
          await client.removeRelay({ relayUrl: String(args['relayUrl']) })
        );
      case 'toon_add_apex': {
        const req: AddApexRequest = {
          ilpAddress: String(args['ilpAddress']),
          relayUrl: String(args['relayUrl']),
          ...(typeof args['pubkey'] === 'string'
            ? { pubkey: args['pubkey'] }
            : {}),
          ...(typeof args['chain'] === 'string'
            ? { chain: args['chain'] as SettlementChain }
            : {}),
          ...(Array.isArray(args['childPeers'])
            ? { childPeers: (args['childPeers'] as unknown[]).map(String) }
            : {}),
          ...(typeof args['feePerEvent'] === 'string'
            ? { feePerEvent: args['feePerEvent'] }
            : {}),
        };
        return ok(await client.addApex(req));
      }
      case 'toon_remove_apex':
        return ok(await client.removeApex({ btpUrl: String(args['btpUrl']) }));
      case 'toon_http_fetch_paid': {
        const req: H402FetchRequest = { url: String(args['url']) };
        if (typeof args['method'] === 'string') req.method = args['method'];
        if (args['headers'] && typeof args['headers'] === 'object')
          req.headers = args['headers'] as Record<string, string>;
        if (typeof args['body'] === 'string') req.body = args['body'];
        if (typeof args['timeout'] === 'number') req.timeout = args['timeout'];
        return ok(await client.httpFetchPaid(req));
      }
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    // A 504 is a retryable apex-discovery timeout — give a discovery-specific
    // hint rather than the daemon-bootstrapping one.
    if (e instanceof ControlApiError && e.status === 504) {
      return err(
        `${e.detail ?? e.message} — retry once the relay is reachable and the apex is online.`
      );
    }
    if (e instanceof ControlApiError && e.retryable) {
      return err(
        `TOON client is still bootstrapping (the anon proxy / BTP session can take ` +
          `30–90s) — retry shortly. (${e.message})`
      );
    }
    if (e instanceof DaemonUnreachableError) {
      return err(
        `TOON client daemon is not reachable at ${e.baseUrl}. It may have failed ` +
          `to start — check ~/.toon-client/daemon.log.`
      );
    }
    if (e instanceof ControlApiError) {
      return err(`${e.message}${e.detail ? `: ${e.detail}` : ''}`);
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Result carrying machine-readable `structuredContent` for the MCP-app iframe. */
function okStructured(
  text: string,
  structuredContent: Record<string, unknown>
): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
