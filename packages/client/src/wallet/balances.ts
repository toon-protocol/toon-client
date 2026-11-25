/**
 * Read-only on-chain wallet balances.
 *
 * Reports what your OWN wallet holds on each configured chain — the native coin
 * and the settlement token — as a free read: no signing, no transaction, no
 * money moved. It has nothing to do with a payment channel's balance, which is
 * collateral already locked on chain and is reported by the channel facade.
 *
 * Each read goes through the settlement network's own RPC client for its chain
 * (toon-client#777), so a hidden payer's balance read rides the same proxied
 * route its channel does. The caller treats each chain best-effort: a chain
 * whose RPC is unreachable degrades to `unreadable` rather than failing the
 * others.
 */
import type { PublicClient } from 'viem';
import { PROXIED_RPC_DEFAULTS } from '../transport/rpc.js';
import type { EvmRpc } from '../channel/batch-settlement/evm-network.js';
import type { SolanaRpcClient } from '../channel/solana/json-rpc.js';

/** One on-chain wallet token balance. `amount` is base-unit integer, decimal. */
export interface WalletBalance {
  chain: 'evm' | 'solana';
  address: string;
  amount: string;
  /** Token symbol, when resolved (e.g. `'USDC'`). */
  asset?: string;
  /** Token decimals, when resolved. */
  assetScale?: number;
}

/**
 * One asset amount within a chain's wallet view — the native coin or one token.
 * `amount` is a base-unit integer, decimal string.
 */
export interface WalletTokenAmount {
  /** Asset symbol (e.g. `'ETH'`, `'SOL'`, `'USDC'`), when known. */
  symbol?: string;
  /** Base-unit integer, decimal string. */
  amount: string;
  /** Decimals for formatting (ETH 18, SOL 9, USDC 6). */
  decimals?: number;
  /** Token contract / SPL mint address. Absent for the native coin. */
  address?: string;
}

/**
 * The full wallet view for ONE chain the identity is configured for: the native
 * coin plus every configured token, keyed by the chain's full key (e.g.
 * `'evm:84532'`). `unreadable` marks a chain whose RPC could not be reached at
 * all — the caller renders a per-chain notice rather than crashing.
 */
export interface WalletChainBalances {
  chain: 'evm' | 'solana';
  /** Full chain key, e.g. `'evm:base-sepolia:84532'`, `'solana'`. */
  chainKey: string;
  address: string;
  /** Native-coin balance, when readable. */
  native?: WalletTokenAmount;
  /** Configured token balances (e.g. USDC), each best-effort. */
  tokens: WalletTokenAmount[];
  /** True when nothing on this chain could be read (RPC unreachable). */
  unreadable?: boolean;
  /** First read error, when any read failed (for diagnostics). */
  error?: string;
}

/** Minimal ERC-20 read ABI (balance + metadata). */
const ERC20_READ_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

/** Extract the numeric chainId from an `evm:{network}:{chainId}` / `evm:{chainId}` key. */
export function parseEvmChainId(chainKey: string): number {
  const parts = chainKey.split(':');
  const idStr = parts.length >= 3 ? parts[2] : parts[1];
  const id = Number.parseInt(idStr ?? '', 10);
  if (!Number.isFinite(id)) throw new Error(`Invalid EVM chain key "${chainKey}".`);
  return id;
}

/**
 * Per-request network timeout (ms) for ONE wallet-balance RPC/GraphQL call.
 * Node's global `fetch` has NO default timeout, so a single stalled socket would
 * otherwise hang the entire multi-chain read until the caller's outer bound —
 * making one flaky endpoint hide the balances of every chain. Bounding each call
 * (viem's own `timeout` for EVM; the JSON-RPC call's own for Solana)
 * lets a slow endpoint degrade only its own chain to `unreadable`. Env override
 * `TOON_WALLET_RPC_TIMEOUT_MS` (`0` disables).
 */
const RPC_TIMEOUT_ENV = 'TOON_WALLET_RPC_TIMEOUT_MS';
const DEFAULT_RPC_TIMEOUT_MS = 8_000;
/**
 * The default through the SOCKS5h proxy: a read that needs a fresh circuit took
 * up to 13s in connector ADR 0073's measurements, so 8s would report a healthy
 * chain `unreadable` on a cold daemon.
 */
const DEFAULT_PROXIED_RPC_TIMEOUT_MS = PROXIED_RPC_DEFAULTS.timeout;

function rpcTimeoutMs(proxied = false): number {
  const raw =
    typeof process !== 'undefined' ? process.env?.[RPC_TIMEOUT_ENV] : undefined;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return proxied ? DEFAULT_PROXIED_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS;
}

/** The reads an EVM balance needs, as a viem public client has them. */
export type EvmBalanceReader = Pick<PublicClient, 'getBalance' | 'readContract'>;

/** Read an ERC-20 token balance (balance + decimals + symbol) for `owner`. */
export async function readEvmTokenBalance(opts: {
  client: EvmBalanceReader;
  tokenAddress: string;
  owner: string;
}): Promise<WalletBalance> {
  const { client } = opts;
  const token = opts.tokenAddress as `0x${string}`;
  const owner = opts.owner as `0x${string}`;
  const [amount, decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [owner] }),
    client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'decimals' }).catch(() => undefined),
    client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'symbol' }).catch(() => undefined),
  ]);
  const out: WalletBalance = { chain: 'evm', address: opts.owner, amount: (amount as bigint).toString() };
  if (typeof symbol === 'string' && symbol) out.asset = symbol;
  if (decimals !== undefined) out.assetScale = Number(decimals);
  return out;
}

/** Read the native ETH balance (wei) for `owner` via `eth_getBalance`. */
export async function readEvmNativeBalance(opts: {
  client: EvmBalanceReader;
  owner: string;
}): Promise<WalletTokenAmount> {
  const wei = await opts.client.getBalance({ address: opts.owner as `0x${string}` });
  return { symbol: 'ETH', amount: wei.toString(), decimals: 18 };
}

/** One wallet read: a single try, bounded by {@link rpcTimeoutMs}. */
function walletRead(rpc: SolanaRpcClient, method: string, params: unknown[]): Promise<unknown> {
  return rpc.request(method, params, { timeoutMs: rpcTimeoutMs(rpc.proxied), retry: false });
}

/** Read the native SOL balance (lamports) for `owner` via the `getBalance` RPC. */
export async function readSolanaNativeBalance(opts: {
  rpc: SolanaRpcClient;
  owner: string;
}): Promise<WalletTokenAmount> {
  const result = (await walletRead(opts.rpc, 'getBalance', [
    opts.owner,
    { commitment: 'confirmed' },
  ])) as { value?: number | string } | null;
  const lamports = BigInt(result?.value ?? 0);
  return { symbol: 'SOL', amount: lamports.toString(), decimals: 9 };
}

/** Read the SPL-token balance for `owner`'s token account(s) of `mint`. */
export async function readSolanaTokenBalance(opts: {
  rpc: SolanaRpcClient;
  mint: string;
  owner: string;
}): Promise<WalletBalance> {
  const result = (await walletRead(opts.rpc, 'getTokenAccountsByOwner', [
    opts.owner,
    { mint: opts.mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ])) as {
    value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } } }[];
  } | null;
  let amount = 0n;
  let decimals: number | undefined;
  for (const acc of result?.value ?? []) {
    const ta = acc.account?.data?.parsed?.info?.tokenAmount;
    if (ta?.amount) amount += BigInt(ta.amount);
    if (ta?.decimals !== undefined) decimals = ta.decimals;
  }
  const out: WalletBalance = { chain: 'solana', address: opts.owner, amount: amount.toString() };
  if (decimals !== undefined) out.assetScale = decimals;
  return out;
}

/**
 * Per-chain inputs for {@link readWalletBalances}: the settlement network's RPC,
 * the identity's address on that chain, and the connector's settlement token —
 * sourced by the caller, never hardcoded here. A chain
 * key absent from the object is simply not read.
 */
export interface WalletBalanceSources {
  evm?: {
    chainKey: string;
    owner: string;
    tokenAddress?: string;
    /** The EVM settlement network's RPC. */
    rpc: EvmRpc;
  };
  solana?: {
    chainKey?: string;
    owner: string;
    tokenMint?: string;
    /** The Solana settlement network's RPC. */
    rpc: SolanaRpcClient;
  };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Fold a settled native read into the chain view, recording any failure. */
function foldNative(
  out: WalletChainBalances,
  settled: PromiseSettledResult<WalletTokenAmount>,
  errors: string[]
): void {
  if (settled.status === 'fulfilled') out.native = settled.value;
  else errors.push(errText(settled.reason));
}

/** Fold a settled token read (a `WalletBalance`) into the chain view. */
function foldToken(
  out: WalletChainBalances,
  settled: PromiseSettledResult<WalletBalance | undefined>,
  tokenAddress: string | undefined,
  errors: string[]
): void {
  if (settled.status === 'rejected') {
    errors.push(errText(settled.reason));
    return;
  }
  const bal = settled.value;
  if (!bal) return;
  out.tokens.push({
    symbol: bal.asset,
    amount: bal.amount,
    decimals: bal.assetScale,
    ...(tokenAddress ? { address: tokenAddress } : {}),
  });
}

/** Mark a chain unreadable when nothing could be read; attach the first error. */
function finalizeChain(out: WalletChainBalances, errors: string[]): void {
  if (errors.length > 0) out.error = errors[0];
  if (out.native === undefined && out.tokens.length === 0) out.unreadable = true;
}

/**
 * Read the full wallet view — native coin + configured tokens — for every chain
 * in `sources`, keyed per chain. FREE: read-only RPC, no signing. Each chain is
 * read independently and in parallel; a chain whose RPC is unreachable degrades
 * to `{ unreadable: true, error }` instead of failing the others. Within a chain
 * the native and token reads are independent, so a native read can succeed even
 * if the token read fails (and vice versa).
 */
export async function readWalletBalances(
  sources: WalletBalanceSources
): Promise<WalletChainBalances[]> {
  const tasks: Promise<WalletChainBalances>[] = [];

  if (sources.evm) {
    const { chainKey, owner, tokenAddress, rpc } = sources.evm;
    const timeout = rpcTimeoutMs(rpc.proxied);
    const client = rpc.reader({ ...(timeout ? { timeout } : {}), retryCount: 1 });
    tasks.push(
      (async () => {
        const out: WalletChainBalances = { chain: 'evm', chainKey, address: owner, tokens: [] };
        const errors: string[] = [];
        const [nativeR, tokenR] = await Promise.allSettled([
          readEvmNativeBalance({ client, owner }),
          tokenAddress
            ? readEvmTokenBalance({ client, tokenAddress, owner })
            : Promise.resolve<WalletBalance | undefined>(undefined),
        ]);
        foldNative(out, nativeR, errors);
        foldToken(out, tokenR, tokenAddress, errors);
        finalizeChain(out, errors);
        return out;
      })()
    );
  }

  if (sources.solana) {
    const { chainKey = 'solana', owner, tokenMint, rpc } = sources.solana;
    tasks.push(
      (async () => {
        const out: WalletChainBalances = { chain: 'solana', chainKey, address: owner, tokens: [] };
        const errors: string[] = [];
        const [nativeR, tokenR] = await Promise.allSettled([
          readSolanaNativeBalance({ rpc, owner }),
          tokenMint
            ? readSolanaTokenBalance({ rpc, mint: tokenMint, owner })
            : Promise.resolve<WalletBalance | undefined>(undefined),
        ]);
        foldNative(out, nativeR, errors);
        // Solana SPL reads carry no symbol from `getTokenAccountsByOwner`; the
        // negotiated settlement token is USDC on every configured chain.
        if (tokenR.status === 'fulfilled' && tokenR.value && tokenR.value.asset === undefined) {
          tokenR.value.asset = 'USDC';
        }
        foldToken(out, tokenR, tokenMint, errors);
        finalizeChain(out, errors);
        return out;
      })()
    );
  }

  return Promise.all(tasks);
}
