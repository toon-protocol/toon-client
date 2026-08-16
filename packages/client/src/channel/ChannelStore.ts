import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ChannelStoreEntry {
  nonce: number;
  cumulativeAmount: bigint;
  /** Unix SECONDS when close was initiated (withdraw flow). */
  closedAt?: bigint;
  /** Unix SECONDS the channel becomes settleable (= closedAt + settlementTimeout). */
  settleableAt?: bigint;
  /** Unix SECONDS the channel was settled (collateral released). */
  settledAt?: bigint;
}

/**
 * Chain context needed to re-track a RESUMED channel — the same shape
 * {@link ChannelManager.trackChannel} takes.
 */
export interface ChannelBindingContext {
  chainType: string;
  chainId: number;
  tokenNetworkAddress: string;
  tokenAddress?: string;
  /** Counterparty settlement address (required for Solana/Mina proofs). */
  recipient?: string;
}

/**
 * One persisted peer→channel binding: WHICH on-chain channel this identity
 * already holds with a peer, on a given chain + token network (#489).
 */
export interface ChannelBinding {
  /** On-chain payment channel id (EVM bytes32 / Solana PDA / Mina zkApp). */
  channelId: string;
  /** Context for `trackChannel` on resume. */
  context: ChannelBindingContext;
  /** On-chain collateral locked at open time, when the open surfaced it. */
  depositTotal?: bigint;
  /** ISO timestamp of the open that created this binding. */
  openedAt?: string;
  /**
   * ISO timestamp this binding was RETIRED from the resume path because its
   * peer now announces a different settlement address than the channel was
   * opened against (see `counterpartyMatch` / {@link ChannelStore.supersedeBinding}).
   * A superseded binding is never resumed again, but stays in
   * {@link ChannelStore.listBindings} so whatever it holds on-chain can still
   * be found and reclaimed.
   */
  supersededAt?: string;
}

/**
 * Persistence interface for payment channel nonce/amount state.
 *
 * The binding methods are OPTIONAL so a third-party `ChannelStore` written
 * against the pre-#489 surface still satisfies the type; a store that omits
 * them simply can't resume a peer's channel across restarts (it will open a
 * fresh one, the old behaviour). {@link JsonFileChannelStore} implements them.
 */
export interface ChannelStore {
  save(channelId: string, tracking: ChannelStoreEntry): void;
  load(channelId: string): ChannelStoreEntry | undefined;
  list(): string[];
  delete(channelId: string): void;
  /** Persist the channel a peer key is bound to. */
  saveBinding?(key: string, binding: ChannelBinding): void;
  /** The channel a peer key is bound to, if any. */
  loadBinding?(key: string): ChannelBinding | undefined;
  /** Every persisted binding, keyed as {@link saveBinding} stored it. */
  listBindings?(): { key: string; binding: ChannelBinding }[];
  /** Forget a binding (its nonce watermark is deliberately left intact). */
  deleteBinding?(key: string): void;
  /**
   * Retire a binding from the resume path — the counterparty terminating its
   * peer's route has been REPLACED, so the channel it names is dead to the
   * node now answering (`F01 - claim rejected`) even though every key field
   * still matches.
   *
   * ARCHIVES rather than deletes: the retired channel may still hold an
   * on-chain deposit, so dropping it would strand those funds behind
   * hand-editing the JSON. It disappears from {@link loadBinding} (never
   * resumed again) and frees its live key for the re-resolved channel, while
   * {@link listBindings} still shows it. Idempotent; a no-op for an unknown
   * key. Optional, like the rest of the binding surface: a store that omits it
   * simply keeps the pre-validation behaviour of overwriting the stale record.
   */
  supersedeBinding?(key: string): void;
}

interface JsonEntry {
  nonce: number;
  /** Stored as string to preserve bigint precision */
  cumulativeAmount: string;
  /** Withdraw-flow timers, string-encoded SECONDS (bigint precision). */
  closedAt?: string;
  settleableAt?: string;
  settledAt?: string;
}

interface JsonBinding {
  channelId: string;
  context: ChannelBindingContext;
  /** Stored as string to preserve bigint precision. */
  depositTotal?: string;
  openedAt?: string;
  supersededAt?: string;
}

/**
 * The archive key a superseded binding moves to: its live key plus the channel
 * id, so the retired record survives the re-resolved channel being written
 * under the live key, and several supersessions of one route never collide.
 */
function supersededKey(key: string, channelId: string): string {
  return `${key}|superseded:${channelId}`;
}

/** `channels.json` → `channels.peers.json`. */
function defaultBindingsPath(filePath: string): string {
  return filePath.replace(/\.json$/i, '') + '.peers.json';
}

/**
 * JSON file-backed ChannelStore.
 * Uses synchronous I/O to match ChannelManager's sync API surface.
 *
 * Two files, on purpose: the nonce/cumulative watermark keeps its historical
 * `{ [channelId]: entry }` schema in `filePath` (rig and the MCP daemon parse
 * that file directly), while the peer→channel bindings live in a SIBLING file
 * (`channels.json` → `channels.peers.json`, override with `bindingsPath`).
 * Extending the watermark file's schema in place would have broken those
 * external readers.
 */
export class JsonFileChannelStore implements ChannelStore {
  private readonly filePath: string;
  private readonly bindingsPath: string;

  constructor(filePath: string, options?: { bindingsPath?: string }) {
    this.filePath = filePath;
    this.bindingsPath = options?.bindingsPath ?? defaultBindingsPath(filePath);
  }

  save(channelId: string, tracking: ChannelStoreEntry): void {
    const data = this.readFile();
    data[channelId] = {
      nonce: tracking.nonce,
      cumulativeAmount: tracking.cumulativeAmount.toString(),
      ...(tracking.closedAt !== undefined
        ? { closedAt: tracking.closedAt.toString() }
        : {}),
      ...(tracking.settleableAt !== undefined
        ? { settleableAt: tracking.settleableAt.toString() }
        : {}),
      ...(tracking.settledAt !== undefined
        ? { settledAt: tracking.settledAt.toString() }
        : {}),
    };
    this.writeFile(data);
  }

  load(channelId: string): ChannelStoreEntry | undefined {
    const data = this.readFile();
    const entry = data[channelId];
    if (!entry) return undefined;
    return {
      nonce: entry.nonce,
      cumulativeAmount: BigInt(entry.cumulativeAmount),
      ...(entry.closedAt !== undefined
        ? { closedAt: BigInt(entry.closedAt) }
        : {}),
      ...(entry.settleableAt !== undefined
        ? { settleableAt: BigInt(entry.settleableAt) }
        : {}),
      ...(entry.settledAt !== undefined
        ? { settledAt: BigInt(entry.settledAt) }
        : {}),
    };
  }

  list(): string[] {
    return Object.keys(this.readFile());
  }

  delete(channelId: string): void {
    const data = this.readFile();
    const { [channelId]: _, ...rest } = data;
    this.writeFile(rest);
  }

  saveBinding(key: string, binding: ChannelBinding): void {
    const data = this.readBindings();
    data[key] = {
      channelId: binding.channelId,
      context: binding.context,
      ...(binding.depositTotal !== undefined
        ? { depositTotal: binding.depositTotal.toString() }
        : {}),
      openedAt: binding.openedAt ?? new Date().toISOString(),
      ...(binding.supersededAt !== undefined
        ? { supersededAt: binding.supersededAt }
        : {}),
    };
    this.writeBindings(data);
  }

  loadBinding(key: string): ChannelBinding | undefined {
    const entry = this.readBindings()[key];
    if (!entry) return undefined;
    // A retired record is not a resume candidate, even if something wrote one
    // back under the live key.
    if (entry.supersededAt !== undefined) return undefined;
    return toBinding(entry);
  }

  listBindings(): { key: string; binding: ChannelBinding }[] {
    return Object.entries(this.readBindings()).map(([key, entry]) => ({
      key,
      binding: toBinding(entry),
    }));
  }

  deleteBinding(key: string): void {
    const data = this.readBindings();
    if (!(key in data)) return;
    const { [key]: _removed, ...rest } = data;
    this.writeBindings(rest);
  }

  supersedeBinding(key: string): void {
    const data = this.readBindings();
    const existing = data[key];
    if (!existing || existing.supersededAt !== undefined) return;
    const { [key]: _retired, ...rest } = data;
    this.writeBindings({
      ...rest,
      [supersededKey(key, existing.channelId)]: {
        ...existing,
        supersededAt: new Date().toISOString(),
      },
    });
  }

  private readFile(): Record<string, JsonEntry> {
    if (!existsSync(this.filePath)) {
      return {};
    }
    const raw = readFileSync(this.filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, JsonEntry>;
  }

  private writeFile(data: Record<string, JsonEntry>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private readBindings(): Record<string, JsonBinding> {
    if (!existsSync(this.bindingsPath)) return {};
    const raw = readFileSync(this.bindingsPath, 'utf-8');
    return JSON.parse(raw) as Record<string, JsonBinding>;
  }

  private writeBindings(data: Record<string, JsonBinding>): void {
    mkdirSync(dirname(this.bindingsPath), { recursive: true });
    writeFileSync(this.bindingsPath, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
}

function toBinding(entry: JsonBinding): ChannelBinding {
  return {
    channelId: entry.channelId,
    context: entry.context,
    ...(entry.depositTotal !== undefined
      ? { depositTotal: BigInt(entry.depositTotal) }
      : {}),
    ...(entry.openedAt !== undefined ? { openedAt: entry.openedAt } : {}),
    ...(entry.supersededAt !== undefined
      ? { supersededAt: entry.supersededAt }
      : {}),
  };
}

/**
 * In-memory {@link ChannelStore} (watermarks + bindings). Handy for tests and
 * for a process that wants resume semantics within its own lifetime without
 * touching disk.
 */
export class InMemoryChannelStore implements ChannelStore {
  private readonly entries = new Map<string, ChannelStoreEntry>();
  private readonly bindings = new Map<string, ChannelBinding>();

  save(channelId: string, tracking: ChannelStoreEntry): void {
    this.entries.set(channelId, { ...tracking });
  }

  load(channelId: string): ChannelStoreEntry | undefined {
    const entry = this.entries.get(channelId);
    return entry ? { ...entry } : undefined;
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  delete(channelId: string): void {
    this.entries.delete(channelId);
  }

  saveBinding(key: string, binding: ChannelBinding): void {
    this.bindings.set(key, {
      ...binding,
      openedAt: binding.openedAt ?? new Date().toISOString(),
    });
  }

  loadBinding(key: string): ChannelBinding | undefined {
    const binding = this.bindings.get(key);
    if (!binding || binding.supersededAt !== undefined) return undefined;
    return { ...binding };
  }

  listBindings(): { key: string; binding: ChannelBinding }[] {
    return [...this.bindings.entries()].map(([key, binding]) => ({
      key,
      binding: { ...binding },
    }));
  }

  deleteBinding(key: string): void {
    this.bindings.delete(key);
  }

  supersedeBinding(key: string): void {
    const binding = this.bindings.get(key);
    if (!binding || binding.supersededAt !== undefined) return;
    this.bindings.delete(key);
    this.bindings.set(supersededKey(key, binding.channelId), {
      ...binding,
      supersededAt: new Date().toISOString(),
    });
  }
}
