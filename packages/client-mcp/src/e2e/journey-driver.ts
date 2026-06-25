/**
 * Library-grade, in-package Claude-agent journey driver (WS5).
 *
 * This is the in-`@toon-protocol/client-mcp` counterpart to the standalone
 * `journey/runner.mjs` scaffold (PR #33): it drives the full SocialFi + DeFi
 * journey headlessly by pointing the Claude Agent SDK's `query()` at the
 * `toon-mcp` stdio MCP server, returns a structured `JourneyResult`, and is
 * launchable both as a gated integration test and as the `toon-journey` bin.
 *
 * Reconciliation (canonical, per issue #28): the runtime is the **Claude Agent
 * SDK** — NOT `mcp-use`. `query()` spawns the bundled Claude Code CLI which
 * authenticates from the environment via `CLAUDE_CODE_OAUTH_TOKEN`
 * (Max-plan), not a raw `ANTHROPIC_API_KEY`.
 *
 * Phases (fixed sequence, each with an explicit `RESULT: PASS|FAIL` rubric line
 * the driver parses):
 *   connect  (read-only, always)         — toon_status / toon_identity reachability.
 *   socialfi (profile/note/follow)       — paid Nostr writes + read-back.
 *   store    (DVM media upload)          — toon_upload + read-back.
 *   defi     (open channel + tiny swap)  — settlement receipt + on-chain assert.
 *
 * On the DeFi phase the agent is asked to emit a machine-readable
 * `SETTLEMENT: { ... }` JSON line describing the on-chain receipt; the driver
 * parses it and calls the matching #27 assertion helper
 * (`assertEvmUsdcSettle` / `assertSolanaReceipt` / `assertMinaReceipt`). When no
 * settlement is parseable (e.g. no swap counterparty), the phase's on-chain
 * assertion is omitted — the driver cannot fabricate chain parameters.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  assertEvmUsdcSettle,
  assertSolanaReceipt,
  assertMinaReceipt,
} from './assert-receipt.js';

export type JourneyMode = 'test' | 'demo';
export type JourneyPhaseName = 'connect' | 'socialfi' | 'store' | 'defi';

export interface JourneyOpts {
  mnemonic: string; // TOON_CLIENT_MNEMONIC — daemon derives the wallet
  configPath: string; // TOON_CLIENT_CONFIG — client config.json (testnet)
  model?: string; // default 'sonnet' (CLAUDE_MODEL) — HUMAN INPUT to confirm
  maxTurns?: number; // default 30; per-phase agent turn cap
  mode?: JourneyMode; // default 'test'; 'demo' streams steps interactively
  phases?: JourneyPhaseName[]; // default all; 'connect' alone == smoke
  onStep?: (s: JourneyStep) => void; // demo-mode progress hook (stream to stdout)
}

export interface JourneyStep {
  phase: JourneyPhaseName;
  transcript: string; // accumulated assistant text for the phase
  pass: boolean; // parsed from "RESULT: PASS|FAIL" rubric line
  assertion?: { kind: 'evm' | 'solana' | 'mina'; ok: boolean; detail?: string };
}

export interface JourneyResult {
  mode: JourneyMode;
  model: string;
  steps: JourneyStep[];
  passed: boolean; // true iff every executed step passed (incl. assertions)
}

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_TURNS = 30;
const SERVER = 'toon';

/** `mcp__toon__toon_<name>` — the Agent-SDK-surfaced tool id for a toon tool. */
const T = (n: string): string => `mcp__${SERVER}__toon_${n}`;

/** Read-only / chain-free tool set (always allowed). */
const READ = [
  T('status'),
  T('identity'),
  T('query'),
  T('read'),
  T('channels'),
  T('targets'),
];

const RUBRIC = `When done, end your reply with exactly one line:
"RESULT: PASS" if every step and its read-back verification succeeded, otherwise
"RESULT: FAIL: <short reason>". Keep all amounts/fees minimal.`;

/**
 * Extra DeFi-only rubric: ask the agent to surface a machine-readable
 * settlement descriptor the driver can hand to the #27 assertion helpers.
 */
const SETTLEMENT_RUBRIC = `If a swap settled on-chain, also emit on its own line a
machine-readable settlement descriptor as compact JSON, prefixed exactly with
"SETTLEMENT: ", with these fields:
  { "kind": "evm" | "solana" | "mina",
    "txHash": "<evm 0x-hash | mina tx hash>",      // evm/mina
    "signature": "<solana signature>",             // solana
    "recipient": "<payout address on the target chain>",
    "amount": "<expected amount in base units, as a decimal string>",
    "usdcAddress": "<evm token contract 0x-address>",   // evm only
    "mintAddress": "<solana SPL mint address>" }         // solana only
Omit the SETTLEMENT line entirely if no swap settled (e.g. no counterparty).`;

interface PhaseDef {
  name: JourneyPhaseName;
  tools: string[];
  goal: string;
}

const PHASES: Record<JourneyPhaseName, PhaseDef> = {
  connect: {
    name: 'connect',
    tools: READ,
    goal: `Validate connectivity to the TOON apex. Call toon_status and toon_identity and
report: is the daemon bootstrapped, is the relay connected, and what are the public Nostr
+ EVM/Solana/Mina addresses? Read-only — do not publish, upload, swap, or spend.`,
  },
  socialfi: {
    name: 'socialfi',
    tools: [...READ, T('subscribe'), T('publish_unsigned')],
    goal: `SocialFi leg (pay-to-write, tiny fees). In order:
1. Publish a profile (kind 0) with a short name + about.
2. Publish a note (kind 1) with a short message.
3. Follow one pubkey (kind 3) — you may follow your own/apex pubkey.
Then read back via toon_query (kinds [0,1,3] for your pubkey) and CONFIRM the note and
profile are present. Report the published event ids.`,
  },
  store: {
    name: 'store',
    tools: [...READ, T('upload_media')],
    goal: `Store leg. Upload a TINY media blob (a few bytes, e.g. a small text or 1x1 PNG
as base64) via toon_upload, then read it back and CONFIRM an Arweave URL / tx id was
returned and the media event is retrievable. Report the URL/tx.`,
  },
  defi: {
    name: 'defi',
    tools: [...READ, T('open_channel'), T('swap'), T('channels')],
    goal: `DeFi leg (tiny amounts only). Open or pre-open a payment channel
(toon_open_channel), then perform ONE minimal swap (toon_swap). Read back via
toon_channels and CONFIRM the channel exists and report the swap's settlement receipt /
chain claim. If no swap counterparty is available, say so explicitly.`,
  },
};

const ALL_PHASES: JourneyPhaseName[] = ['connect', 'socialfi', 'store', 'defi'];

/** Parsed settlement descriptor the agent emits on the DeFi phase. */
interface SettlementDescriptor {
  kind: 'evm' | 'solana' | 'mina';
  txHash?: string;
  signature?: string;
  recipient?: string;
  amount?: string;
  usdcAddress?: string;
  mintAddress?: string;
  rpcUrl?: string;
}

/** True iff the transcript carries a passing `RESULT:` rubric line. */
export function parseRubric(transcript: string): boolean {
  if (/RESULT:\s*FAIL/i.test(transcript)) return false;
  return /RESULT:\s*PASS/i.test(transcript);
}

/**
 * Pull the last `SETTLEMENT: { ... }` JSON line out of a transcript, if any.
 * Returns `undefined` when absent or unparseable (no swap settled).
 */
export function parseSettlement(
  transcript: string
): SettlementDescriptor | undefined {
  const matches = [...transcript.matchAll(/SETTLEMENT:\s*(\{.*?\})\s*$/gim)];
  if (matches.length === 0) return undefined;
  const raw = matches[matches.length - 1]?.[1];
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Partial<SettlementDescriptor>;
    if (obj.kind === 'evm' || obj.kind === 'solana' || obj.kind === 'mina') {
      return obj as SettlementDescriptor;
    }
  } catch {
    /* malformed JSON → treat as no settlement */
  }
  return undefined;
}

/**
 * Call the #27 on-chain assertion helper matching a parsed settlement
 * descriptor. Returns the per-step `assertion` outcome. The helpers throw on
 * mismatch; any throw becomes `{ ok: false, detail }`.
 *
 * `rpcUrl` for each chain is sourced from the descriptor or the corresponding
 * env var (TOON_EVM_RPC / TOON_SOLANA_RPC / TOON_MINA_RPC).
 */
async function runAssertion(
  s: SettlementDescriptor
): Promise<NonNullable<JourneyStep['assertion']>> {
  try {
    if (s.kind === 'evm') {
      if (!s.txHash || !s.usdcAddress || !s.recipient || s.amount == null) {
        return { kind: 'evm', ok: false, detail: 'incomplete EVM descriptor' };
      }
      await assertEvmUsdcSettle({
        txHash: s.txHash as `0x${string}`,
        usdcAddress: s.usdcAddress as `0x${string}`,
        recipient: s.recipient as `0x${string}`,
        expectedAmount: BigInt(s.amount),
        rpcUrl: s.rpcUrl ?? process.env['TOON_EVM_RPC'],
      });
      return { kind: 'evm', ok: true };
    }
    if (s.kind === 'solana') {
      if (!s.signature || !s.mintAddress || !s.recipient || s.amount == null) {
        return {
          kind: 'solana',
          ok: false,
          detail: 'incomplete Solana descriptor',
        };
      }
      await assertSolanaReceipt({
        signature: s.signature,
        recipient: s.recipient,
        mintAddress: s.mintAddress,
        expectedAmount: BigInt(s.amount),
        rpcUrl: s.rpcUrl ?? process.env['TOON_SOLANA_RPC'],
      });
      return { kind: 'solana', ok: true };
    }
    // mina
    if (!s.txHash || !s.recipient || s.amount == null) {
      return { kind: 'mina', ok: false, detail: 'incomplete Mina descriptor' };
    }
    await assertMinaReceipt({
      txHash: s.txHash,
      recipient: s.recipient,
      expectedAmount: BigInt(s.amount),
      rpcUrl: s.rpcUrl ?? process.env['TOON_MINA_RPC'],
    });
    return { kind: 'mina', ok: true };
  } catch (err) {
    return {
      kind: s.kind,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Drop undefined values so the SDK gets a clean `Record<string, string>` env. */
function mcpEnv(opts: JourneyOpts): Record<string, string> {
  const env: Record<string, string> = {
    TOON_CLIENT_CONFIG: opts.configPath,
    TOON_CLIENT_MNEMONIC: opts.mnemonic,
  };
  // Inherit the parent env so the Claude credential + PATH flow through to the
  // `toon-mcp` subprocess (and the daemon it spawns).
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !(k in env)) env[k] = v;
  }
  return env;
}

/** Run a single phase via the Agent SDK; collect transcript + verdict. */
async function runPhase(
  phase: PhaseDef,
  opts: JourneyOpts,
  model: string,
  maxTurns: number,
  env: Record<string, string>
): Promise<JourneyStep> {
  const rubric =
    phase.name === 'defi' ? `${RUBRIC}\n\n${SETTLEMENT_RUBRIC}` : RUBRIC;

  let transcript = '';
  for await (const message of query({
    prompt: `${phase.goal}\n\n${rubric}`,
    options: {
      model,
      maxTurns,
      allowedTools: phase.tools,
      // allow-listed tools auto-approved; others denied (fail-safe).
      permissionMode: 'default',
      mcpServers: {
        [SERVER]: { type: 'stdio', command: 'toon-mcp', args: [], env },
      },
    },
  })) {
    if (message.type === 'assistant') {
      const content = message.message?.content;
      const text = Array.isArray(content)
        ? content
            .filter(
              (b): b is { type: 'text'; text: string } => b.type === 'text'
            )
            .map((b) => b.text)
            .join('')
        : '';
      if (text) transcript += text + '\n';
    } else if (message.type === 'result') {
      const text = 'result' in message ? (message.result ?? '') : '';
      if (text) transcript += text;
    }
  }

  const step: JourneyStep = {
    phase: phase.name,
    transcript,
    pass: parseRubric(transcript),
  };

  // On the DeFi phase, verify any reported settlement on-chain via #27 helpers.
  if (phase.name === 'defi') {
    const settlement = parseSettlement(transcript);
    if (settlement) {
      const assertion = await runAssertion(settlement);
      step.assertion = assertion;
      // A reported-but-failing on-chain assertion fails the phase.
      if (!assertion.ok) step.pass = false;
    }
  }

  return step;
}

/**
 * Drive the connect → socialfi → store → defi journey through the Claude Agent
 * SDK against the `toon-mcp` tools, verify each DeFi settlement on-chain via the
 * #27 assertion helpers, and return per-step outcomes + an aggregate verdict.
 *
 * Requires a Claude credential in the environment (`CLAUDE_CODE_OAUTH_TOKEN`,
 * Max-plan). Each phase runs its own `query()` with an allow-listed tool set.
 */
export async function runJourney(opts: JourneyOpts): Promise<JourneyResult> {
  const model = opts.model ?? process.env['CLAUDE_MODEL'] ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const mode: JourneyMode = opts.mode ?? 'test';
  const phaseNames = opts.phases ?? ALL_PHASES;
  const env = mcpEnv(opts);

  const steps: JourneyStep[] = [];
  for (const name of phaseNames) {
    const phase = PHASES[name];
    let step: JourneyStep;
    try {
      step = await runPhase(phase, opts, model, maxTurns, env);
    } catch (err) {
      step = {
        phase: name,
        transcript: err instanceof Error ? err.message : String(err),
        pass: false,
      };
    }
    steps.push(step);
    opts.onStep?.(step);
  }

  const passed = steps.length > 0 && steps.every((s) => s.pass);
  return { mode, model, steps, passed };
}
