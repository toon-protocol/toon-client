/**
 * MCP tool definitions + dispatch. The MCP server is a thin proxy: each tool
 * maps to a `toon-clientd` control API call. This module is the testable core
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
import { basename } from 'node:path';
import type { NostrEvent } from 'nostr-tools/pure';
import { ControlApiError, DaemonUnreachableError } from './control-client.js';
import type { ControlClient } from './control-client.js';
import type {
  AddApexRequest,
  GitEstimateRequest,
  GitEstimateResponse,
  GitPatchRequest,
  GitPushResponse,
  GitRepoAddr,
  GitStatusValue,
  HttpFetchPaidRequest,
  NostrFilter,
  PublishRequest,
  PublishUnsignedRequest,
  SettlementChain,
  SwapRequest,
  UploadMediaRequest,
} from './control-api.js';

/**
 * MCP behavioural hints (per the spec's `ToolAnnotations`). Hosts read these to
 * decide what to auto-run vs gate: free reads can skip approval, paid/irreversible
 * writes get a confirmation prompt. All hints are advisory, so a host MUST NOT
 * relax its own gating based on them — but a compliant host CAN use them to gate.
 */
export interface ToolAnnotations {
  /** Does not mutate state — the host may run it without a write prompt. */
  readOnlyHint?: boolean;
  /** May perform irreversible/destructive updates (paid writes; channel close). */
  destructiveHint?: boolean;
  /** Repeated calls with the same args have no additional effect. */
  idempotentHint?: boolean;
  /** Touches an external/open world (relays, chains, the wider web). */
  openWorldHint?: boolean;
}

/** A JSON-Schema-described MCP tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Behavioural hints for the host (read-only vs paid/destructive write). */
  annotations?: ToolAnnotations;
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
      'NOT a render prerequisite — do NOT call this to "check health" before a ' +
      'read-only render; render directly and let the UI surface daemon state. ' +
      'Reach for it only when a write reports bootstrapping or the user asks ' +
      'about connection/health. To display this to the user, render it via ' +
      'toon_render — not a generic widget or plain text.',
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
      'addresses). Never returns private keys. Not needed before read-only ' +
      'renders; relevant only to confirm which key will sign a paid write.',
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
      'Returns the event id, channel id, the advanced channel nonce, and the ' +
      'fee paid. PAID + IRREVERSIBLE: on a text-only host, quote the fee via ' +
      'toon_status and confirm with the user before calling.',
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
      'This is the path MCP-app UI actions use so the iframe never signs. ' +
      'PAID + IRREVERSIBLE: on a text-only host, quote the fee via toon_status ' +
      'and confirm with the user before calling.',
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
      'Single-packet only. PAID + IRREVERSIBLE (pays for both the upload and the ' +
      'reference event): on a text-only host, quote the fee via toon_status and ' +
      'confirm with the user before calling.',
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
    name: 'toon_git_push',
    description:
      'Pay-to-write: push a local git repository to TOON (NIP-34) — uploads ' +
      'the object delta to Arweave via the paid store and publishes the ' +
      'cumulative kind:30618 refs event (+ kind:30617 announcement on first ' +
      'push). The daemon identity is the repo owner. TWO-STEP, PAID + ' +
      'IRREVERSIBLE: ALWAYS call with dry_run:true first — it plans the push ' +
      'without paying and returns the itemized fee table (per-object upload ' +
      'fees + event fees). Quote estimate.totalFee to the user and get their ' +
      'explicit confirmation, THEN call again with confirm:true to execute; a ' +
      'push without confirm:true is rejected. Uploads and events are permanent ' +
      'and non-refundable (they cannot be unpublished).',
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: {
          type: 'string',
          description:
            'Absolute path to the local git repository (worktree or .git dir) ' +
            'the daemon reads with git plumbing.',
        },
        repoId: {
          type: 'string',
          description:
            'Repository identifier (NIP-34 `d` tag). Default: the basename ' +
            'of repoPath with any trailing `.git` stripped (so /repos/demo, ' +
            '/repos/demo/.git and /repos/demo.git all derive "demo").',
        },
        refspecs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Full refnames to push (e.g. ["refs/heads/main"]). Default: every ' +
            'local branch and tag.',
        },
        force: {
          type: 'boolean',
          description:
            'Allow non-fast-forward updates (default false). A forced push ' +
            'abandons remote commits — get explicit user confirmation first.',
        },
        relayUrls: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Relay URLs to read remote state from and publish to (default: ' +
            "the daemon's config-seeded relay).",
        },
        dry_run: {
          type: 'boolean',
          description:
            'true → plan + price only (free, nothing is paid or published). ' +
            'Required first step before any real push.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be literally true to execute the paid push — only after the ' +
            'user confirmed the dry_run fee quote.',
        },
      },
      required: ['repoPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_git_issue',
    description:
      'Pay-to-write: file a NIP-34 issue (kind:1621) against a TOON-hosted ' +
      'repo. One paid event publish. PAID + IRREVERSIBLE: quote the per-event ' +
      'fee (feePerEvent via toon_status / fee config) and confirm with the ' +
      'user before calling — events cannot be unpublished.',
    inputSchema: {
      type: 'object',
      properties: {
        repoOwnerPubkey: {
          type: 'string',
          description:
            "Repository owner's Nostr pubkey (64-char hex — the author of the " +
            'kind:30617 announcement).',
        },
        repoId: {
          type: 'string',
          description: 'Repository identifier (NIP-34 `d` tag).',
        },
        title: { type: 'string', description: 'Issue title (`subject` tag).' },
        body: { type: 'string', description: 'Issue body (Markdown).' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels (`t` tags).',
        },
      },
      required: ['repoOwnerPubkey', 'repoId', 'title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_git_comment',
    description:
      'Pay-to-write: comment (kind:1622) on a TOON-hosted issue or patch. One ' +
      'paid event publish. PAID + IRREVERSIBLE: quote the per-event fee ' +
      '(feePerEvent via toon_status / fee config) and confirm with the user ' +
      'before calling — events cannot be unpublished.',
    inputSchema: {
      type: 'object',
      properties: {
        repoOwnerPubkey: {
          type: 'string',
          description: "Repository owner's Nostr pubkey (64-char hex).",
        },
        repoId: {
          type: 'string',
          description: 'Repository identifier (NIP-34 `d` tag).',
        },
        rootEventId: {
          type: 'string',
          description: 'Event id of the issue or patch being commented on.',
        },
        body: { type: 'string', description: 'Comment body (Markdown).' },
        parentAuthorPubkey: {
          type: 'string',
          description:
            "Pubkey of the TARGET event's author (NIP-34 `p` threading tag). " +
            'Default: the repo owner.',
        },
        marker: {
          type: 'string',
          enum: ['root', 'reply'],
          description:
            '`e`-tag marker (default root: commenting directly on the ' +
            'issue/patch).',
        },
      },
      required: ['repoOwnerPubkey', 'repoId', 'rootEventId', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_git_patch',
    description:
      'Pay-to-write: submit a patch/PR (kind:1617, real `git format-patch` ' +
      'content) to a TOON-hosted repo. Supply EXACTLY ONE of patchText ' +
      '(literal format-patch output) or repoPath+range (the daemon runs ' +
      'format-patch locally). One paid event publish. PAID + IRREVERSIBLE: ' +
      'quote the per-event fee (feePerEvent via toon_status / fee config) and ' +
      'confirm with the user before calling — events cannot be unpublished.',
    inputSchema: {
      type: 'object',
      properties: {
        repoOwnerPubkey: {
          type: 'string',
          description: "Repository owner's Nostr pubkey (64-char hex).",
        },
        repoId: {
          type: 'string',
          description: 'Repository identifier (NIP-34 `d` tag).',
        },
        title: { type: 'string', description: 'Patch/PR title (`subject` tag).' },
        patchText: {
          type: 'string',
          description:
            'Literal `git format-patch` output. Mutually exclusive with ' +
            'repoPath+range.',
        },
        repoPath: {
          type: 'string',
          description:
            'Local repository to run format-patch in. Requires range.',
        },
        range: {
          type: 'string',
          description:
            'Revision range for format-patch (`<rev>`, `<rev>..<rev>`, ' +
            '`<rev>...<rev>`).',
        },
        branch: { type: 'string', description: 'Branch name for the `t` tag.' },
      },
      required: ['repoOwnerPubkey', 'repoId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'toon_git_status',
    description:
      'Pay-to-write: set the status of a TOON-hosted issue or patch ' +
      '(kind:1630-1633: open/applied/closed/draft). One paid event publish. ' +
      'PAID + IRREVERSIBLE: quote the per-event fee (feePerEvent via ' +
      'toon_status / fee config) and confirm with the user before calling — ' +
      'events cannot be unpublished.',
    inputSchema: {
      type: 'object',
      properties: {
        repoOwnerPubkey: {
          type: 'string',
          description: "Repository owner's Nostr pubkey (64-char hex).",
        },
        repoId: {
          type: 'string',
          description: 'Repository identifier (NIP-34 `d` tag).',
        },
        targetEventId: {
          type: 'string',
          description: 'Event id of the issue/patch whose status is being set.',
        },
        status: {
          type: 'string',
          enum: ['open', 'applied', 'closed', 'draft'],
          description:
            'open → kind:1630, applied → 1631, closed → 1632, draft → 1633.',
        },
      },
      required: ['repoOwnerPubkey', 'repoId', 'targetEventId', 'status'],
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
      'decrypted target-chain claim(s) and settlement metadata. PAID + ' +
      'IRREVERSIBLE: on a text-only host, confirm the amount with the user ' +
      'before calling.',
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
    name: 'toon_fund_status',
    description:
      'Check the status of async faucet drips submitted via toon_fund_wallet. ' +
      'Each job reports `status` (`pending` | `success` | `error`), the chain/' +
      'address, and timestamps — so an agent can poll for settlement without ' +
      're-dripping. With no `chain` it returns every tracked job.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: {
          type: 'string',
          enum: ['evm', 'solana', 'mina'],
          description: 'Only report the drip job for this chain (default: all).',
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

// --- Tool annotations -------------------------------------------------------
// Behavioural hints the host uses to gate writes and auto-run reads. Kept in one
// place so the read/write split is auditable at a glance and stays consistent
// with the UI-fireable WRITE_TOOLS set (asserted at load below). Reads that touch
// relays/chains are flagged openWorld; paid/irreversible writes are destructive.
const READ_LOCAL: ToolAnnotations = { readOnlyHint: true };
const READ_NET: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const PAID_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const ONCHAIN_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
const CONFIG_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // free reads — local daemon state
  toon_status: READ_LOCAL,
  toon_identity: READ_LOCAL,
  toon_atoms: READ_LOCAL,
  toon_render: READ_LOCAL,
  toon_channels: READ_LOCAL,
  toon_targets: READ_LOCAL,
  // free reads — touch relays / chains
  toon_query: READ_NET,
  toon_subscribe: READ_NET,
  toon_read: READ_NET,
  toon_balances: READ_NET,
  toon_fund_status: READ_NET,
  // paid, irreversible writes (signed event broadcast + spent channel claim)
  toon_publish: PAID_WRITE,
  toon_publish_unsigned: PAID_WRITE,
  toon_upload: PAID_WRITE,
  toon_swap: PAID_WRITE,
  // paid git writes (NIP-34): push uploads objects + publishes events; the
  // single-event tools each spend one channel claim. toon_git_push with
  // dry_run:true is a free estimate, but the tool as a whole is a paid write.
  toon_git_push: PAID_WRITE,
  toon_git_issue: PAID_WRITE,
  toon_git_comment: PAID_WRITE,
  toon_git_patch: PAID_WRITE,
  toon_git_status: PAID_WRITE,
  // on-chain channel ops
  toon_open_channel: { ...ONCHAIN_WRITE, idempotentHint: true }, // returns the existing channel if open
  toon_channel_deposit: ONCHAIN_WRITE,
  toon_channel_settle: ONCHAIN_WRITE,
  toon_channel_close: { ...ONCHAIN_WRITE, destructiveHint: true }, // begins the irreversible settlement
  toon_http_fetch_paid: ONCHAIN_WRITE, // pays on 402, then returns the resource
  // receives faucet funds — mutates balances, but not a spend
  toon_fund_wallet: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  // reversible, persisted config edits
  toon_add_relay: CONFIG_WRITE,
  toon_remove_relay: CONFIG_WRITE,
  toon_add_apex: { ...CONFIG_WRITE, openWorldHint: true }, // discovers the apex's kind:10032 off a relay
  toon_remove_apex: CONFIG_WRITE,
};

// Attach annotations and fail fast on drift: every tool must be classified, and
// every UI-fireable write (WRITE_TOOLS) must be non-read-only so hosts gate it.
for (const def of TOOL_DEFINITIONS) {
  const annotations = TOOL_ANNOTATIONS[def.name];
  if (!annotations) throw new Error(`mcp-tools: missing annotations for tool ${def.name}`);
  def.annotations = annotations;
}
for (const name of WRITE_TOOLS) {
  if (TOOL_ANNOTATIONS[name]?.readOnlyHint !== false) {
    throw new Error(`mcp-tools: WRITE_TOOLS member ${name} must be annotated readOnlyHint:false`);
  }
}

/**
 * Dispatch an MCP tool call to the daemon control API. Always resolves with a
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
      case 'toon_git_push': {
        const req: GitEstimateRequest = {
          repoPath: String(args['repoPath'] ?? ''),
          repoId:
            typeof args['repoId'] === 'string' && args['repoId'] !== ''
              ? args['repoId']
              : defaultRepoId(String(args['repoPath'] ?? '')),
          ...(Array.isArray(args['refspecs'])
            ? { refspecs: (args['refspecs'] as unknown[]).map(String) }
            : {}),
          ...(typeof args['force'] === 'boolean' ? { force: args['force'] } : {}),
          ...(Array.isArray(args['relayUrls'])
            ? { relayUrls: (args['relayUrls'] as unknown[]).map(String) }
            : {}),
        };
        if (args['dry_run'] === true) {
          const plan = await client.gitEstimate(req);
          // Compact text: the per-object manifest can be thousands of entries,
          // so the text channel carries counts + the fee table (everything the
          // confirm quote needs); the full plan rides structuredContent.
          return okStructured(
            JSON.stringify(compactPushPlan(plan)) +
              `\nQuote estimate.totalFee (base units) to the user and get ` +
              `explicit confirmation before pushing with confirm:true — the ` +
              `push is permanent and non-refundable.`,
            plan as unknown as Record<string, unknown>
          );
        }
        if (args['confirm'] !== true) {
          return err(
            `Refusing to push without confirm:true. Run toon_git_push with ` +
              `dry_run:true first (free), quote estimate.totalFee to the user, ` +
              `and only after their explicit confirmation call again with ` +
              `confirm:true. Pushes are PAID, permanent, and non-refundable.`
          );
        }
        const pushed = await client.gitPush({ ...req, confirm: true });
        return okStructured(
          JSON.stringify(compactPushResult(pushed)),
          pushed as unknown as Record<string, unknown>
        );
      }
      case 'toon_git_issue':
        return ok(
          await client.gitIssue({
            repoAddr: gitRepoAddr(args),
            title: String(args['title'] ?? ''),
            body: String(args['body'] ?? ''),
            ...(Array.isArray(args['labels'])
              ? { labels: (args['labels'] as unknown[]).map(String) }
              : {}),
          })
        );
      case 'toon_git_comment':
        return ok(
          await client.gitComment({
            repoAddr: gitRepoAddr(args),
            rootEventId: String(args['rootEventId'] ?? ''),
            body: String(args['body'] ?? ''),
            ...(typeof args['parentAuthorPubkey'] === 'string'
              ? { parentAuthorPubkey: args['parentAuthorPubkey'] }
              : {}),
            ...(args['marker'] === 'root' || args['marker'] === 'reply'
              ? { marker: args['marker'] }
              : {}),
          })
        );
      case 'toon_git_patch': {
        const req: GitPatchRequest = {
          repoAddr: gitRepoAddr(args),
          title: String(args['title'] ?? ''),
          ...(typeof args['patchText'] === 'string'
            ? { patchText: args['patchText'] }
            : {}),
          ...(typeof args['repoPath'] === 'string'
            ? { repoPath: args['repoPath'] }
            : {}),
          ...(typeof args['range'] === 'string' ? { range: args['range'] } : {}),
          ...(typeof args['branch'] === 'string'
            ? { branch: args['branch'] }
            : {}),
        };
        return ok(await client.gitPatch(req));
      }
      case 'toon_git_status':
        return ok(
          await client.gitStatus({
            repoAddr: gitRepoAddr(args),
            targetEventId: String(args['targetEventId'] ?? ''),
            status: String(args['status'] ?? '') as GitStatusValue,
          })
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
        // Decision-sufficient text for a NON-RENDERING host: name the view and
        // the atoms it composes, and point at the free reads that carry the
        // actual data — so a text-only host isn't left with an opaque "rendering"
        // line it cannot act on (MCP-Apps text-fallback requirement).
        const atomIds = [...new Set(collectAtomIds(check.spec.root))];
        const title = check.spec.title ? `: ${check.spec.title}` : '';
        return okStructured(
          `Rendering view${title} (atoms: ${atomIds.join(', ') || 'none'}). ` +
            `This is a UI card for a rendering host; a text-only host should read ` +
            `the underlying data via toon_query / toon_read.`,
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
        // Carry a decision-sufficient TEXT summary (author/time/excerpt/counts)
        // alongside structuredContent: a NON-RENDERING host sees only the text,
        // so a bare "N event(s)." would strand it with no way to reason about
        // the feed/thread it just read (MCP-Apps text-fallback requirement).
        return okStructured(summarizeEvents(res.events), { events: res.events });
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
      case 'toon_read': {
        const res = await client.events({
          ...(typeof args['subId'] === 'string' ? { subId: args['subId'] } : {}),
          ...(typeof args['cursor'] === 'number' ? { cursor: args['cursor'] } : {}),
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
          ...(typeof args['relayUrl'] === 'string'
            ? { relayUrl: args['relayUrl'] }
            : {}),
        });
        // Same text-fallback contract as toon_query: a readable summary for
        // text-only hosts, plus the cursor so the agent can drain the next page;
        // the full `{ events, cursor, hasMore }` rides structuredContent for the
        // iframe.
        const cursorNote = res.hasMore
          ? ` More available — read again with cursor ${res.cursor}.`
          : ` Cursor ${res.cursor}.`;
        return okStructured(summarizeEvents(res.events) + cursorNote, {
          events: res.events,
          cursor: res.cursor,
          hasMore: res.hasMore,
        });
      }
      case 'toon_open_channel':
        return ok(
          await client.openChannel(
            typeof args['destination'] === 'string'
              ? { destination: args['destination'] }
              : {}
          )
        );
      case 'toon_channels':
        // Enforce the wire contract at the daemon boundary: ALWAYS emit a plain
        // `{ channels: [...] }` object so `ok()` mirrors it into
        // `structuredContent`. A bare-array regression would otherwise be
        // silently dropped (Array.isArray guard in `ok`) → blank UI (#200).
        return ok(wrapList('channels', await client.channels()));
      case 'toon_balances':
        // Same wire contract as toon_channels: always `{ balances: [...] }` so
        // `structuredContent.balances` is never dropped, even if
        // `client.balances()` regresses to a bare array (#200).
        return ok(wrapList('balances', await client.balances()));
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
      case 'toon_fund_wallet': {
        // The drip is async: the daemon returns a 'pending' snapshot immediately
        // (the Mina faucet settles in ~75s, past the host's tool-call timeout).
        const job = await client.fundWallet({
          ...(typeof args['chain'] === 'string'
            ? { chain: args['chain'] as SettlementChain }
            : {}),
          ...(typeof args['address'] === 'string'
            ? { address: args['address'] }
            : {}),
        });
        return okStructured(
          `Drip submitted for ${job.chain} to ${job.address}. Funds appear in ` +
            `balances once the faucet settles (EVM/Solana ~30s, Mina ~1-2 min). ` +
            `Re-check with toon_balances, or poll toon_fund_status.`,
          job as unknown as Record<string, unknown>
        );
      }
      case 'toon_fund_status':
        return ok(
          await client.fundStatus(
            typeof args['chain'] === 'string'
              ? (args['chain'] as SettlementChain)
              : undefined
          )
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
    // A 504 on a balance read is the `:8787` balances handler stalling on a
    // chain RPC/provider — NOT the relay/apex (#199). Name the real failing
    // subsystem and do not assert relay/apex is the probable cause; toon_status
    // stays `ready` throughout and the read succeeds on retry.
    if (e instanceof ControlApiError && e.status === 504 && name === 'toon_balances') {
      return err(
        `${e.detail ?? e.message} — the balances control API (:8787 GET ` +
          `/balances) stalled reading on-chain balances; the relay and apex are ` +
          `unaffected. Retry shortly.`
      );
    }
    // A 504 on a fund request is the faucet being slow (the mina faucet settles
    // in ~75s), NOT the relay/apex. The drip may still land server-side — point
    // at the faucet and tell the user to re-check balances, not to chase the
    // relay (#199-class attribution on the /fund-wallet path).
    if (e instanceof ControlApiError && e.status === 504 && name === 'toon_fund_wallet') {
      return err(
        `${e.detail ?? e.message} — the faucet drip did not return in time (the ` +
          `mina faucet settles slowly); the relay and apex are unaffected. The ` +
          `funds may still land — re-check balances shortly, or retry.`
      );
    }
    // Any other 504 is a retryable apex-discovery timeout — give a
    // discovery-specific hint rather than the daemon-bootstrapping one.
    if (e instanceof ControlApiError && e.status === 504) {
      return err(
        `${e.detail ?? e.message} — retry once the relay is reachable and the apex is online.`
      );
    }
    // A 402 is the one-time on-chain channel OPEN failing for lack of native gas
    // (#65). The `detail` is already the actionable "fund the wallet and retry"
    // message — surface it verbatim. Must precede the generic retryable branch
    // below, or the gas remedy is masked by the "still bootstrapping" hint even
    // though this error is flagged retryable-after-funding.
    if (e instanceof ControlApiError && e.status === 402) {
      return err(e.detail ?? e.message);
    }
    // Structured /git/* errors carry their data on ControlApiError.data —
    // surface it as compact JSON (agents consume these) plus an actionable hint,
    // instead of flattening to `message: detail` and losing the refs/objects.
    if (e instanceof ControlApiError && e.message === 'non_fast_forward') {
      return err(
        JSON.stringify({
          error: 'non_fast_forward',
          detail: e.detail,
          refs: e.data?.['refs'] ?? [],
          hint:
            'The remote moved since the last known state. Re-run toon_git_push ' +
            'with dry_run:true and force:true to preview the forced update, get ' +
            'explicit user confirmation (a forced push abandons the remote ' +
            'commits), then push with force:true + confirm:true.',
        })
      );
    }
    if (e instanceof ControlApiError && e.message === 'oversize_objects') {
      return err(
        JSON.stringify({
          error: 'oversize_objects',
          detail: e.detail,
          objects: e.data?.['objects'] ?? [],
          hint:
            'These objects exceed the 95KB single-packet upload limit — a v1 ' +
            'hard error (paid blob storage for larger objects is the epic #222 ' +
            'follow-up, toon-client#235). Remove or shrink the listed paths ' +
            '(e.g. git filter-repo) and re-run the estimate.',
        })
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

/**
 * Normalize a list-shaped read into the wire-contract object the MCP-app iframe
 * depends on: `{ [key]: [...] }`. Accepts either the already-wrapped object
 * (pass-through, no double-wrap) or a bare array (defensive — wraps it), so the
 * read seam ALWAYS yields a plain object `ok()` mirrors into `structuredContent`
 * rather than a bare array it would silently drop (#200).
 */
function wrapList(
  key: 'balances' | 'channels',
  res: unknown
): Record<string, unknown> {
  if (Array.isArray(res)) return { [key]: res };
  if (res !== null && typeof res === 'object') {
    const existing = (res as Record<string, unknown>)[key];
    if (Array.isArray(existing)) return res as Record<string, unknown>;
  }
  return { [key]: [] };
}

/**
 * Default NIP-34 repoId for a repoPath: the basename with any trailing `.git`
 * stripped, so a worktree's `.git` dir (`/repos/demo/.git`) and a bare repo
 * (`/repos/demo.git`) both derive `demo` — never the literal `".git"`, which
 * would collide every such repo pushed by the same identity onto one paid,
 * irreversible `a`-tag address.
 */
function defaultRepoId(repoPath: string): string {
  const trimmed = repoPath.replace(/[/\\]+$/, '');
  const base = basename(trimmed);
  if (base === '.git') {
    return basename(trimmed.slice(0, -'.git'.length).replace(/[/\\]+$/, ''));
  }
  return base.length > '.git'.length && base.endsWith('.git')
    ? base.slice(0, -'.git'.length)
    : base;
}

/** Flattened NIP-34 repo address from the toon_git_* tool args. */
function gitRepoAddr(args: Record<string, unknown>): GitRepoAddr {
  return {
    ownerPubkey: String(args['repoOwnerPubkey'] ?? ''),
    repoId: String(args['repoId'] ?? ''),
  };
}

/**
 * Compact text rendering of a push plan: keep the ref updates + itemized fee
 * table (what the confirm quote needs) but replace the per-object manifest and
 * sha→txId map — potentially thousands of entries — with counts. The full plan
 * rides `structuredContent`.
 */
function compactPushPlan(plan: GitEstimateResponse): Record<string, unknown> {
  const { objects, knownShaToTxId, newRefs, ...rest } = plan;
  return {
    ...rest,
    newRefCount: Object.keys(newRefs).length,
    plannedObjectCount: objects.length,
    knownOnArweaveCount: Object.keys(knownShaToTxId).length,
  };
}

/** Same compaction for the push receipts: counts + fees, full result aside. */
function compactPushResult(res: GitPushResponse): Record<string, unknown> {
  const { uploads, arweaveMap, ...rest } = res;
  return {
    ...rest,
    uploadCount: uploads.length,
    skippedUploadCount: uploads.filter((u) => u.skipped).length,
    arweaveMapSize: Object.keys(arweaveMap).length,
  };
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

/** Human label for a Nostr event kind, for the text fallback. */
function kindLabel(kind: number): string {
  switch (kind) {
    case 0:
      return 'profile';
    case 1:
      return 'note';
    case 3:
      return 'follow list';
    case 7:
      return 'reaction';
    case 20:
    case 21:
    case 22:
      return 'media';
    case 1063:
      return 'file';
    default:
      return `kind:${kind}`;
  }
}

/** Abbreviate a 64-char hex id/pubkey to `head…tail` for readable text. */
function shortHex(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

/** Collapse whitespace and clip content to a single, bounded excerpt line. */
function excerpt(content: string, max = 140): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * A compact, decision-sufficient TEXT rendering of a set of Nostr events for
 * NON-RENDERING hosts, which see ONLY `content[].text` (never structuredContent).
 * Per the MCP-Apps spec every UI-feeding read must ALSO return readable text, so
 * the agent can reason about a feed/thread/profile even when it can't render the
 * card. Notes surface author/time/excerpt + like counts (NIP-25 `e`-tag tally);
 * other kinds get a typed one-liner. Bounded to `max` lines so a large page
 * stays readable. Exported for direct unit testing.
 */
export function summarizeEvents(events: NostrEvent[], max = 20): string {
  if (events.length === 0) return 'No matching events.';

  // Tally reactions per targeted note (NIP-25 `e` tag) so a note line can show
  // its like count — the engagement signal a feed card would render. Defensive
  // against partial event objects (some come straight off the wire).
  const eTag = (e: NostrEvent): string | undefined =>
    (Array.isArray(e.tags) ? e.tags : []).find((t) => t[0] === 'e')?.[1];
  const likes = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 7) continue;
    const target = eTag(e);
    if (target) likes.set(target, (likes.get(target) ?? 0) + 1);
  }

  const kindCounts = new Map<string, number>();
  for (const e of events) {
    const label = kindLabel(e.kind);
    kindCounts.set(label, (kindCounts.get(label) ?? 0) + 1);
  }
  const breakdown = [...kindCounts.entries()]
    .map(([label, n]) => `${n} ${label}${n === 1 ? '' : 's'}`)
    .join(', ');

  const lines = events.slice(0, max).map((e) => {
    const who = `by ${shortHex(e.pubkey ?? '?')}`;
    const when = Number.isFinite(e.created_at)
      ? new Date(e.created_at * 1000).toISOString()
      : 'unknown time';
    if (e.kind === 7) {
      const target = eTag(e);
      const emoji = excerpt(e.content ?? '') || '+';
      return `• reaction "${emoji}" ${who}${target ? ` → ${shortHex(target)}` : ''}`;
    }
    const body = excerpt(e.content ?? '');
    const likeCount = likes.get(e.id) ?? 0;
    const likeSuffix = likeCount > 0 ? ` · ${likeCount} like${likeCount === 1 ? '' : 's'}` : '';
    const bodySuffix = body ? ` · "${body}"` : '';
    return `• ${kindLabel(e.kind)} ${who} · ${when}${bodySuffix}${likeSuffix}`;
  });

  const more = events.length > max ? `\n…and ${events.length - max} more.` : '';
  return `${events.length} event(s) — ${breakdown}.\n${lines.join('\n')}${more}`;
}

/** Recursively collect every atom id referenced by a ViewSpec node tree. */
function collectAtomIds(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as { atom?: unknown; children?: unknown };
  const ids: string[] = typeof n.atom === 'string' ? [n.atom] : [];
  if (Array.isArray(n.children)) {
    for (const child of n.children) ids.push(...collectAtomIds(child));
  }
  return ids;
}
