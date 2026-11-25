import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * The config of an x402 `batch-settlement` channel (connector ADR 0074), in a
 * JSON-safe spelling: every field a string or a number, so both stores persist
 * it verbatim. Its id travels in every voucher and is never derived, so the
 * full config is what must survive a restart — on EVM the contract stores a
 * channel by id and never gives the config back.
 */
export type BatchSettlementBinding =
  | {
      chain: 'evm';
      /** CAIP-2, `eip155:<chainId>`. */
      network: string;
      config: {
        payer: string;
        payerAuthorizer: string;
        receiver: string;
        receiverAuthorizer: string;
        token: string;
        withdrawDelay: number;
        salt: string;
      };
    }
  | {
      chain: 'solana';
      /** CAIP-2, `solana:<genesis prefix>`. */
      network: string;
      /** The receiving connector's sponsor key: the channel's `payee` and `rent_payer`. */
      sponsor: string;
      config: {
        payer: string;
        payerAuthorizer: string;
        receiver: string;
        token: string;
        withdrawDelay: number;
        /** u64, decimal. */
        salt: string;
        /** u64, decimal. */
        openSlot: string;
      };
    };

/**
 * Everything the payer keeps about one x402 `batch-settlement` channel: its
 * config, its deposit, its watermark, its last voucher and its exit
 * timestamps. One record per channel id.
 */
export interface ChannelStoreEntry {
  channelId: string;
  /** The connector the channel pays. Part of how {@link ChannelStore.find} looks it up. */
  connector: string;
  /**
   * The channel's config, which names its network and token. Required: the id
   * travels in every voucher and is never derived, so a channel whose config
   * was not kept cannot be resumed (ADR 0003).
   */
  batchSettlement: BatchSettlementBinding;
  /** On-chain collateral the channel holds, as far as this client knows. */
  depositTotal: bigint;
  /**
   * A deposit handed to a facilitator or a sponsor whose fate is not yet known.
   * Recorded BEFORE the deposit leaves, so a lost answer never loses the
   * channel: the next use reads the chain and settles it.
   */
  pendingDeposit?: bigint;
  /** ISO timestamp the record was created. */
  openedAt?: string;
  /**
   * ISO timestamp the channel was RETIRED because a newer channel took its
   * connector, network and asset. A retired channel is never resumed, but it
   * stays in {@link ChannelStore.list}: it may still hold a deposit.
   */
  supersededAt?: string;
  /** The cumulative amount this client counts as signed. */
  cumulativeAmount: bigint;
  /**
   * The highest cumulative this client has ever SIGNED on the channel, which a
   * rollback deliberately does not lower. It is the ceiling on what the
   * connector can possibly have banked, and so the clamp on adopting the
   * connector's own figure.
   */
  signedCeiling?: bigint;
  /**
   * The highest cumulative the connector is PROVEN to hold: what the chain
   * shows landed, a voucher it banked, or one it refused as not advancing. The
   * floor under adopting the connector's own figure.
   */
  provenFloor?: bigint;
  /**
   * The watermark is in doubt: a refusal said "not advancing" without saying
   * where the connector's watermark is. The next voucher resyncs against the
   * connector before it is signed. Persisted because each `toon-client`
   * invocation is a new process.
   */
  watermarkUncertain?: boolean;
  /**
   * The watermark was not found when an older store was read, so
   * `cumulativeAmount` is a placeholder until it is rebuilt from the chain and
   * the connector.
   */
  watermarkLost?: boolean;
  /**
   * The last voucher sent, as the JSON that travelled. A probe resends it byte
   * for byte, a retransmission the connector records nothing for.
   */
  lastVoucher?: string;
  /** The cumulative amount {@link lastVoucher} names. */
  lastVoucherAmount?: bigint;
  /** Unix SECONDS when close was initiated (withdraw flow). */
  closedAt?: bigint;
  /** Unix SECONDS the withdraw delay ends and the deposit can be taken back. */
  settleableAt?: bigint;
  /** Unix SECONDS the channel was settled (collateral released). */
  settledAt?: bigint;
}

/**
 * The store the payer's channel records live in. Every method is required: a
 * store that cannot persist the channel config cannot resume a channel.
 */
export interface ChannelStore {
  /** Write the record for `entry.channelId`, replacing any earlier one. */
  save(entry: ChannelStoreEntry): void;
  load(channelId: string): ChannelStoreEntry | undefined;
  /**
   * The live (not retired) channel for `connector` on `network` in `asset`, if
   * there is one.
   */
  find(
    connector: string,
    network: string,
    asset: string
  ): ChannelStoreEntry | undefined;
  /** Every record, live or retired. */
  list(): ChannelStoreEntry[];
  /** Forget a record. A retired channel is archived with `supersededAt`, never deleted. */
  delete(channelId: string): void;
}

/** What a channel is found by. EVM addresses are case-insensitive, base58 is not. */
function lookupKey(connector: string, network: string, asset: string): string {
  const a = network.startsWith('eip155:') ? asset.toLowerCase() : asset;
  return `${connector}|${network}|${a}`;
}

function keyOf(entry: ChannelStoreEntry): string {
  return lookupKey(
    entry.connector,
    entry.batchSettlement.network,
    entry.batchSettlement.config.token
  );
}

/** The newer of two live records for one key (there should only be one). */
function newer(a: ChannelStoreEntry, b: ChannelStoreEntry): ChannelStoreEntry {
  return (b.openedAt ?? '') >= (a.openedAt ?? '') ? b : a;
}

/** One record as the file holds it: bigints as strings. */
interface JsonEntry {
  /** Absent on the entries of a file older than this layout. */
  channelId?: string;
  connector?: string;
  batchSettlement?: BatchSettlementBinding;
  depositTotal?: string;
  pendingDeposit?: string;
  openedAt?: string;
  supersededAt?: string;
  /** Read by rig under each channel id. */
  cumulativeAmount: string;
  signedCeiling?: string;
  provenFloor?: string;
  watermarkUncertain?: boolean;
  watermarkLost?: boolean;
  lastVoucher?: string;
  lastVoucherAmount?: string;
  closedAt?: string;
  settleableAt?: string;
  settledAt?: string;
}

/** A binding as an older release wrote it to `channels.peers.json`. */
interface LegacyBinding {
  channelId: string;
  depositTotal?: string;
  openedAt?: string;
  supersededAt?: string;
  batchSettlement?: BatchSettlementBinding;
  pendingDeposit?: string;
  lastVoucher?: string;
  lastVoucherAmount?: string;
}

const KEY_PREFIX = 'batch|';

/** `channels.json` → `channels.peers.json`. */
function legacyBindingsPath(filePath: string): string {
  return filePath.replace(/\.json$/i, '') + '.peers.json';
}

const big = (v: string | undefined): bigint | undefined =>
  v === undefined ? undefined : BigInt(v);
const str = (v: bigint | undefined): string | undefined => v?.toString();

function compact<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined)
  ) as T;
}

function toJson(e: ChannelStoreEntry): JsonEntry {
  return compact({
    channelId: e.channelId,
    connector: e.connector,
    batchSettlement: e.batchSettlement,
    depositTotal: e.depositTotal.toString(),
    pendingDeposit: str(e.pendingDeposit),
    openedAt: e.openedAt,
    supersededAt: e.supersededAt,
    cumulativeAmount: e.cumulativeAmount.toString(),
    signedCeiling: str(e.signedCeiling),
    provenFloor: str(e.provenFloor),
    watermarkUncertain: e.watermarkUncertain ? true : undefined,
    watermarkLost: e.watermarkLost ? true : undefined,
    lastVoucher: e.lastVoucher,
    lastVoucherAmount: str(e.lastVoucherAmount),
    closedAt: str(e.closedAt),
    settleableAt: str(e.settleableAt),
    settledAt: str(e.settledAt),
  });
}

/** A record, or `undefined` for a legacy entry that never had a config. */
function fromJson(
  channelId: string,
  j: JsonEntry
): ChannelStoreEntry | undefined {
  if (!j.batchSettlement || j.connector === undefined) return undefined;
  return compact({
    channelId,
    connector: j.connector,
    batchSettlement: j.batchSettlement,
    depositTotal: BigInt(j.depositTotal ?? '0'),
    pendingDeposit: big(j.pendingDeposit),
    openedAt: j.openedAt,
    supersededAt: j.supersededAt,
    cumulativeAmount: BigInt(j.cumulativeAmount),
    signedCeiling: big(j.signedCeiling),
    provenFloor: big(j.provenFloor),
    watermarkUncertain: j.watermarkUncertain ? true : undefined,
    watermarkLost: j.watermarkLost ? true : undefined,
    lastVoucher: j.lastVoucher,
    lastVoucherAmount: big(j.lastVoucherAmount),
    closedAt: big(j.closedAt),
    settleableAt: big(j.settleableAt),
    settledAt: big(j.settledAt),
  });
}

/**
 * JSON file-backed ChannelStore, with synchronous I/O to match
 * BatchChannelManager.
 *
 * One file, `{ [channelId]: record }`. Each record keeps `cumulativeAmount`
 * under its channel id, which rig reads directly.
 *
 * A release that kept bindings in a sibling `channels.peers.json` is migrated
 * on first use: its bindings are joined with the watermarks in `filePath`, the
 * result is written to `filePath`, and the sibling is renamed to
 * `channels.peers.json.migrated`. Fields no longer used (`nonce`, the binding
 * context) are ignored on read and not written back.
 */
export class JsonFileChannelStore implements ChannelStore {
  private readonly filePath: string;
  private readonly legacyPath: string;

  /** `options.bindingsPath` is where an older release kept its bindings. */
  constructor(filePath: string, options?: { bindingsPath?: string }) {
    this.filePath = filePath;
    this.legacyPath = options?.bindingsPath ?? legacyBindingsPath(filePath);
  }

  save(entry: ChannelStoreEntry): void {
    const data = this.readFile();
    data[entry.channelId] = toJson(entry);
    this.writeFile(data);
  }

  load(channelId: string): ChannelStoreEntry | undefined {
    const j = this.readFile()[channelId];
    return j ? fromJson(channelId, j) : undefined;
  }

  find(
    connector: string,
    network: string,
    asset: string
  ): ChannelStoreEntry | undefined {
    const want = lookupKey(connector, network, asset);
    let found: ChannelStoreEntry | undefined;
    for (const e of this.list()) {
      if (e.supersededAt !== undefined || keyOf(e) !== want) continue;
      found = found ? newer(found, e) : e;
    }
    return found;
  }

  list(): ChannelStoreEntry[] {
    return Object.entries(this.readFile()).flatMap(([id, j]) => {
      const e = fromJson(id, j);
      return e ? [e] : [];
    });
  }

  delete(channelId: string): void {
    const data = this.readFile();
    if (!(channelId in data)) return;
    const { [channelId]: _gone, ...rest } = data;
    this.writeFile(rest);
  }

  private readFile(): Record<string, JsonEntry> {
    const data: Record<string, JsonEntry> = existsSync(this.filePath)
      ? (JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<
          string,
          JsonEntry
        >)
      : {};
    return this.migrate(data);
  }

  private migrate(data: Record<string, JsonEntry>): Record<string, JsonEntry> {
    if (!existsSync(this.legacyPath)) return data;
    const legacy = JSON.parse(readFileSync(this.legacyPath, 'utf-8')) as Record<
      string,
      LegacyBinding
    >;
    for (const [key, b] of Object.entries(legacy)) {
      if (!key.startsWith(KEY_PREFIX) || !b.batchSettlement) continue;
      const net = b.batchSettlement.network;
      const connector = key
        .slice(KEY_PREFIX.length)
        .split(`|${net}|`)[0] as string;
      const mark = data[b.channelId];
      const merged: JsonEntry = compact({
        ...mark,
        channelId: b.channelId,
        connector,
        batchSettlement: b.batchSettlement,
        depositTotal: b.depositTotal ?? '0',
        pendingDeposit: b.pendingDeposit,
        openedAt: b.openedAt,
        supersededAt: b.supersededAt,
        lastVoucher: b.lastVoucher,
        lastVoucherAmount: b.lastVoucherAmount,
        cumulativeAmount: mark?.cumulativeAmount ?? '0',
        watermarkLost: mark ? undefined : true,
      });
      data[b.channelId] = merged;
    }
    this.writeFile(data);
    renameSync(this.legacyPath, `${this.legacyPath}.migrated`);
    return data;
  }

  private writeFile(data: Record<string, JsonEntry>): void {
    for (const j of Object.values(data)) {
      delete (j as { nonce?: unknown }).nonce;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
}

/**
 * In-memory {@link ChannelStore}. Handy for tests and for a process that wants
 * resume semantics within its own lifetime without touching disk.
 */
export class InMemoryChannelStore implements ChannelStore {
  private readonly entries = new Map<string, ChannelStoreEntry>();
  /** Live channel id by lookup key. */
  private readonly live = new Map<string, string>();

  save(entry: ChannelStoreEntry): void {
    const key = keyOf(entry);
    this.entries.set(entry.channelId, { ...entry });
    if (entry.supersededAt !== undefined) {
      if (this.live.get(key) === entry.channelId) this.live.delete(key);
    } else {
      this.live.set(key, entry.channelId);
    }
  }

  load(channelId: string): ChannelStoreEntry | undefined {
    const e = this.entries.get(channelId);
    return e ? { ...e } : undefined;
  }

  find(
    connector: string,
    network: string,
    asset: string
  ): ChannelStoreEntry | undefined {
    const id = this.live.get(lookupKey(connector, network, asset));
    return id === undefined ? undefined : this.load(id);
  }

  list(): ChannelStoreEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  delete(channelId: string): void {
    const e = this.entries.get(channelId);
    if (!e) return;
    this.entries.delete(channelId);
    if (this.live.get(keyOf(e)) === channelId) this.live.delete(keyOf(e));
  }
}
