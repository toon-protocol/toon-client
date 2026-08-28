/**
 * How the CLI says things.
 *
 * Two audiences, one code path. A person gets aligned columns and amounts they
 * can read; a script gets `--json`, and the contract there is absolute:
 * **stdout carries exactly one JSON document and nothing else**. Every warning,
 * every prompt, every "falling back to the devnet preset" note goes to stderr,
 * so `toon send … --json | jq` never chokes on a line of prose. {@link
 * Output.render} enforces the "exactly one" half by refusing to be called twice.
 *
 * Amounts are the other thing worth being deliberate about. A payment channel
 * deals in **base units** — the integers the chain and the connector actually
 * agree on — and a CLI that printed only `0.001 USDC` would be hiding the number
 * every error message, every claim and every deposit is denominated in. So both
 * are printed, base units first: `1000 (0.001 USDC)`. The decimals come from the
 * connector's own settlement entry, never from a guess.
 */
import { formatUnits } from 'viem';
import { DEVNET } from '../presets.js';
import type { ChannelTerms } from '../channel/types.js';
import type { ConnectorChainSettlementTerms } from '../connector/self-description.js';

/** Somewhere to write a line of text. Injected so tests never touch a real stream. */
export type Writer = (text: string) => void;

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  stdout?: Writer;
  stderr?: Writer;
}

/**
 * What is needed to render an amount for a person: how many base units make a
 * whole one, and what to call it.
 *
 * Both are optional, and their absence is honest rather than papered over. A
 * node that publishes no decimals gets `1000` and no parenthetical, because a
 * decimal point in the wrong place is worse than no decimal point.
 */
export interface AssetInfo {
  decimals?: number;
  symbol?: string;
}

/**
 * A display label for a token address.
 *
 * This is the one place a preset is consulted, and it is consulted for a
 * **caption**: the connector publishes an asset's decimals but never its
 * symbol, so the alternative is an amount with no name on it. Nothing is ever
 * paid, signed or opened against what this returns — a wrong answer here
 * misspells a word, it does not move money.
 */
export function assetSymbol(tokenAddress: string | undefined): string | undefined {
  if (tokenAddress === undefined) return undefined;
  const t = tokenAddress.toLowerCase();
  if (t === DEVNET.evm.tokenAddress.toLowerCase()) return 'USDC';
  if (t === DEVNET.solana.tokenAddress.toLowerCase()) return 'USDC';
  return undefined;
}

/** The asset facts in a connector's settlement entry, ready to format with. */
export function assetFromSettlement(
  settlement: Pick<ConnectorChainSettlementTerms, 'decimals' | 'tokenAddress'> | undefined
): AssetInfo {
  if (settlement === undefined) return {};
  return { decimals: settlement.decimals, symbol: assetSymbol(settlement.tokenAddress) };
}

/** The asset facts in a channel's signing domain. */
export function assetFromTerms(terms: ChannelTerms | undefined): AssetInfo {
  if (terms === undefined) return {};
  return { decimals: terms.decimals, symbol: assetSymbol(terms.token) };
}

/**
 * `1000 (0.001 USDC)` — base units, then the human figure.
 *
 * Falls back gracefully: no decimals gives `1000`, decimals without a symbol
 * gives `1000 (0.001)`.
 */
export function formatAmount(
  amount: bigint | string | number,
  asset: AssetInfo = {}
): string {
  const base = typeof amount === 'bigint' ? amount : BigInt(amount);
  const raw = base.toString();
  if (asset.decimals === undefined) return raw;
  const human = formatUnits(base, asset.decimals);
  return asset.symbol === undefined ? `${raw} (${human})` : `${raw} (${human} ${asset.symbol})`;
}

/**
 * Convert a value into something `JSON.stringify` can be trusted with.
 *
 * `bigint` becomes a **decimal string**, never a number: every amount this
 * client handles can exceed 2^53, and a JSON number would round it silently —
 * the same reason the connector's own wire spells prices as strings. Bytes
 * become base64. Functions disappear, so a `SendResult`'s `text()`/`json()`
 * helpers cannot leak into the document as `null`.
 */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const converted = toJsonValue(v);
      if (converted !== undefined) out[k] = converted;
    }
    return out;
  }
  return value;
}

/** Render aligned `label  value` rows. */
export function columns(rows: [string, string][], indent = ''): string {
  const width = rows.reduce((w, [left]) => Math.max(w, left.length), 0);
  return rows
    .map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`)
    .join('\n');
}

/**
 * Is this byte string text?
 *
 * Strict UTF-8 decoding, deliberately: a body that *almost* decodes is a body
 * printed with replacement characters where its actual bytes were, which is a
 * lie about what the app returned. If it does not decode cleanly it is binary,
 * and the CLI says so and gives you its size instead.
 */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  private readonly out: Writer;
  private readonly err: Writer;
  private rendered = false;

  constructor(options: OutputOptions = {}) {
    this.json = options.json ?? false;
    this.quiet = options.quiet ?? false;
    this.out = options.stdout ?? ((text) => process.stdout.write(`${text}\n`));
    this.err = options.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  }

  /** A line of human output. Suppressed entirely under `--json`. */
  line(text = ''): void {
    if (!this.json) this.out(text);
  }

  /** Aligned rows of human output. */
  rows(rows: [string, string][], indent = '  '): void {
    if (rows.length > 0) this.line(columns(rows, indent));
  }

  /**
   * A diagnostic. Always stderr — under `--json` because stdout is spoken for,
   * and otherwise because a warning interleaved with results is a warning that
   * gets piped into the next program.
   */
  warn(text: string): void {
    if (!this.quiet) this.err(text);
  }

  /** An error explanation. Stderr, and never suppressed by `--quiet`. */
  error(text: string): void {
    this.err(text);
  }

  /**
   * The command's answer: the JSON document under `--json`, the human rendering
   * otherwise.
   *
   * Calling this twice is a bug in the command, not a formatting choice — two
   * documents on stdout is not JSON — so it throws rather than emitting them.
   */
  render(payload: unknown, human: () => void): void {
    if (this.rendered) {
      throw new Error('Output.render was called twice: --json must emit exactly one document');
    }
    this.rendered = true;
    if (this.json) {
      this.out(JSON.stringify(toJsonValue(payload), null, 2));
    } else {
      human();
    }
  }
}
