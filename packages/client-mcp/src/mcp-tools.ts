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
  HttpFetchPaidRequest,
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
      'relay connection, buffered-event count, and per-chain settlement status. ' +
      'To display this to the user, render it via toon_render — not a generic ' +
      'widget or plain text.',
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
            'Optional ILP destination override (default: the apex/relay).',
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
    name: 'toon_upload',
    description:
      'Pay-to-write upload (SPENDY, two-step): upload the bytes of ANY blob to ' +
      'Arweave via the kind:5094 store/DVM (POST /store through the connector), then ' +
      'sign+publish an event referencing the resulting Arweave URL. Supply the bytes ' +
      'as EXACTLY ONE of `filePath` (an absolute path the daemon reads off disk — ' +
      'preferred, keeps the payload out of the model context) or `dataBase64` (inline ' +
      'base64). The reference event kind defaults to 1063 (NIP-94 media; 20=picture, ' +
      '21/22=video, 1=note w/ NIP-92 imeta) — set `kind` to suit any blob type. ' +
      'Single-packet only.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Absolute path the daemon reads to source the bytes off disk (preferred; ' +
            'mutually exclusive with dataBase64). Bounded by an optional configured upload root.',
        },
        dataBase64: {
          type: 'string',
          description: 'Inline base64-encoded media bytes (mutually exclusive with filePath).',
        },
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
      // Exactly one of filePath | dataBase64 is required; enforced in the daemon
      // (ClientRunner.uploadMedia) since JSON Schema can't express one-of-required cleanly here.
      additionalProperties: false,
    },
  },
  {
    name: 'toon_atoms',
    description:
      'REQUIRED first call before any toon_render — returns the atom allowlist ' +
      '(ids + the kinds each renders, props, write actions) plus example ' +
      'ViewSpecs, for composing a view to pass to toon_render. Never guess atom ' +
      'ids or kinds; always fetch them here first. This is how you build the ' +
      'user a generative UI for their journey.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'toon_render',
    description:
      'PRIMARY display surface for ALL TOON data. Use this — not any generic ' +
      'HTML/SVG/chart/diagram/markdown/widget tool — whenever the user asks to ' +
      'see, show, open, view, browse, render, or compose TOON events, profiles, ' +
      'feeds, threads, channels, balances, or a note. Renders a ViewSpec ' +
      '(atoms + data binds + write actions) inline as ui://toon/app. ALWAYS call ' +
      'toon_atoms first, then build the spec from the returned vocabulary; never ' +
      'guess atom ids/kinds. Composing/rendering is free; atom-fired writes are ' +
      'paid and route through the audited write allowlist, with the pay/consent ' +
      'surface rendered by the trusted host outside the iframe. Fall back to ' +
      'text only on explicit user request or render failure.',
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
      '(subscribes, waits briefly, returns matches). Used to fill ViewSpec binds. ' +
      'To display these events to the user, pass them to toon_render — not a ' +
      'generic widget or plain text.',
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
      'Free read: register a persistent relay subscription with NIP-01 ' +
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
      'returned cursor to fetch only events received since the last read. ' +
      'To display these events to the user, pass them to toon_render — not a ' +
      'generic widget or plain text.',
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
      'List tracked payment channels with their nonce watermark, cumulative ' +
      'transferred amount, locked deposit, and available (spendable) balance. To ' +
      'display these to the user, render them via toon_render — not a generic ' +
      'widget or plain text.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'toon_balances',
    description:
      'Read on-chain wallet token balances for each configured chain (EVM token, ' +
      'Solana SPL, native MINA). Free read, no payment. To display these to the ' +
      'user, render them via toon_render (the wallet atom) — not plain text.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'toon_channel_deposit',
    description:
      'Deposit additional collateral into an open payment channel. `amount` is ' +
      'the delta to add (base micro-units). Spends on-chain (the client signs its ' +
      'own tx). EVM is supported today; Solana/Mina are coming. Returns the new ' +
      'deposit total.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The channel to deposit into.' },
        amount: { type: 'string', description: 'Delta to add, base micro-units (decimal string).' },
      },
      required: ['channelId', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_channel_close',
    description:
      'Close a payment channel to begin the settlement grace period (withdraw, ' +
      'step 1). Spends on-chain. EVM today. Returns closedAt + settleableAt; the ' +
      'channel can be settled (collateral released) once now ≥ settleableAt.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: 'The channel to close.' } },
      required: ['channelId'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_channel_settle',
    description:
      'Settle a closed channel after its grace period to release collateral ' +
      '(withdraw, step 2). Fails as RETRYABLE if called before settleableAt — ' +
      'poll toon_channels for closeState and retry once it is "settleable". Spends ' +
      'on-chain. EVM today.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: 'The closed channel to settle.' } },
      required: ['channelId'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_swap',
    description:
      'Pay a swap peer (asset A) to receive asset B plus a signed target-chain ' +
      'claim. Builds the NIP-59 gift-wrapped kind:20032 swap rumor and streams ' +
      'it; the source-asset claim is signed against the open apex channel (the ' +
      'swap peer must be routed via apexChildPeers). Returns the accumulated, ' +
      'decrypted target-chain claim(s) and settlement metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: {
          type: 'string',
          description: 'Swap peer ILP destination (e.g. g.proxy.swap).',
        },
        amount: {
          type: 'string',
          description: 'Total source-asset amount to swap, source micro-units.',
        },
        swapPubkey: {
          type: 'string',
          description:
            "Swap peer's 64-char lowercase hex Nostr pubkey (gift-wrap recipient).",
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
        'swapPubkey',
        'pair',
        'chainRecipient',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_http_fetch_paid',
    description:
      'Fetch a paid HTTP resource: issues the request, and if the server ' +
      'returns 402 Payment Required, transparently pays over TOON and retries, ' +
      'returning the settled resource. Settlement happens inside the daemon ' +
      'against the open apex channel (the caller never holds chain keys). ' +
      'Returns { status, headers, body } (body decoded as text).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL of the resource to fetch.',
        },
        method: {
          type: 'string',
          description: 'HTTP method (default GET).',
        },
        headers: {
          type: 'object',
          description: 'Request headers as a flat string→string map.',
        },
        body: {
          type: 'string',
          description: 'Request body (string, sent verbatim; e.g. with POST).',
        },
        timeout: {
          type: 'number',
          description: 'Per-request timeout, ms.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_fund_wallet',
    description:
      'Drip devnet test funds to a wallet from the configured faucet (EVM: ' +
      'ETH + USDC, Solana: SOL + USDC, Mina: native MINA + USDC). With no ' +
      "arguments it funds THIS client's own address on the active settlement " +
      'chain — the usual "fund me before I open a channel / pay for writes" ' +
      'step. Requires a faucet to be configured on the daemon.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: {
          type: 'string',
          enum: ['evm', 'solana', 'mina'],
          description: 'Chain to fund (default: the active settlement chain).',
        },
        address: {
          type: 'string',
          description:
            "Address to fund (default: this client's own address for the chain).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'toon_targets',
    description:
      'List every registered target: relays (read sources, with connection + ' +
      'buffered-event status) and apexes (BTP write targets, with ready/' +
      'channel status). The TOON client is 1-to-many — many apexes to write ' +
      'through, many relays to read from. To display these to the user, render ' +
      'them via toon_render — not a generic widget or plain text.',
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
      'all fan-out reads immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        relayUrl: {
          type: 'string',
          description: 'Relay WS URL (ws://host:7100).',
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
          description: 'ILP address of the apex (e.g. g.proxy).',
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
            'Child peers via this apex’s channel (e.g. ["store","swap"]).',
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
      case 'toon_status': {
        const s = await client.status();
        return okStructured(JSON.stringify(s, null, 2), s as unknown as Record<string, unknown>);
      }
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
      case 'toon_upload':
        return ok(
          await client.uploadMedia(args as unknown as UploadMediaRequest)
        );
      case 'toon_atoms': {
        const atomsPayload = { atoms: ATOM_CATALOG, examples: EXAMPLE_VIEWSPECS };
        return okStructured(JSON.stringify(atomsPayload, null, 2), atomsPayload);
      }
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
      case 'toon_balances':
        return ok(await client.balances());
      case 'toon_channel_deposit':
        return ok(
          await client.depositToChannel({
            channelId: String(args['channelId'] ?? ''),
            amount: String(args['amount'] ?? ''),
          })
        );
      case 'toon_channel_close':
        return ok(await client.closeChannel({ channelId: String(args['channelId'] ?? '') }));
      case 'toon_channel_settle':
        return ok(await client.settleChannel({ channelId: String(args['channelId'] ?? '') }));
      case 'toon_swap':
        return ok(
          await client.swap({
            destination: String(args['destination']),
            amount: String(args['amount']),
            swapPubkey: String(args['swapPubkey']),
            pair: args['pair'] as SwapRequest['pair'],
            chainRecipient: String(args['chainRecipient']),
            ...(typeof args['packetCount'] === 'number'
              ? { packetCount: args['packetCount'] }
              : {}),
          })
        );
      case 'toon_http_fetch_paid': {
        const req: HttpFetchPaidRequest = {
          url: String(args['url']),
          ...(typeof args['method'] === 'string'
            ? { method: args['method'] }
            : {}),
          ...(args['headers'] && typeof args['headers'] === 'object'
            ? { headers: args['headers'] as Record<string, string> }
            : {}),
          ...(typeof args['body'] === 'string' ? { body: args['body'] } : {}),
          ...(typeof args['timeout'] === 'number'
            ? { timeout: args['timeout'] }
            : {}),
        };
        return ok(await client.httpFetchPaid(req));
      }
      case 'toon_fund_wallet':
        return ok(
          await client.fundWallet({
            ...(typeof args['chain'] === 'string'
              ? { chain: args['chain'] as SettlementChain }
              : {}),
            ...(typeof args['address'] === 'string'
              ? { address: args['address'] }
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
        `TOON client is still bootstrapping (the BTP session can take a few ` +
          `seconds) — retry shortly. (${e.message})`
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
  const result: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
  // Mirror object payloads into `structuredContent`. The MCP-app iframe bridge
  // only surfaces `structuredContent` as `ToolOutcome.data` (a text-only result
  // gives the atoms `undefined`), so the read seams (`toon_balances`,
  // `toon_channels`) and every write receipt (`eventId`, `depositTotal`,
  // `settleableAt`, …) depend on it. Without this, `wallet-overview` renders
  // addresses but no balance/USDC — the headline #186 symptom — and deposit /
  // withdraw / publish receipts come back blank. Arrays/primitives aren't valid
  // `structuredContent` objects, so only plain objects are mirrored.
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    result.structuredContent = data as Record<string, unknown>;
  }
  return result;
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
