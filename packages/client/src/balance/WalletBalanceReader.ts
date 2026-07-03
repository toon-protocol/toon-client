/**
 * Read-only on-chain wallet balances.
 *
 * Reports the settlement-token balance of the client's OWN wallet on each
 * configured chain — a free read, no signing, no fund movement. Each per-chain
 * reader is independent and injectable (viem for EVM; raw JSON-RPC / GraphQL
 * `fetch` for Solana / Mina, mirroring the existing channel modules) so they
 * unit-test without a live chain. The caller ({@link ../ToonClient}) treats each
 * chain best-effort: a missing config or a failed read drops that chain rather
 * than failing the whole wallet view.
 */
import { createPublicClient, http, defineChain } from 'viem';

/** One on-chain wallet token balance. `amount` is base-unit integer, decimal. */
export interface WalletBalance {
  chain: 'evm' | 'solana' | 'mina';
  address: string;
  amount: string;
  /** Token symbol, when resolved (e.g. `'USDC'`, `'MINA'`). */
  asset?: string;
  /** Token decimals, when resolved. */
  assetScale?: number;
}

/**
 * One asset amount within a chain's wallet view — the native coin or one token.
 * `amount` is a base-unit integer, decimal string.
 */
export interface WalletTokenAmount {
  /** Asset symbol (e.g. `'ETH'`, `'SOL'`, `'MINA'`, `'USDC'`), when known. */
  symbol?: string;
  /** Base-unit integer, decimal string. */
  amount: string;
  /** Decimals for formatting (ETH 18, SOL 9, MINA 9, USDC 6). */
  decimals?: number;
  /** Token contract / SPL mint address. Absent for the native coin. */
  address?: string;
}

/**
 * The full wallet view for ONE chain the identity is configured for: the native
 * coin plus every configured token, keyed by the chain's full key (e.g.
 * `'evm:31337'`). `unreadable` marks a chain whose RPC could not be reached at
 * all — the caller renders a per-chain notice rather than crashing.
 */
export interface WalletChainBalances {
  chain: 'evm' | 'solana' | 'mina';
  /** Full chain key, e.g. `'evm:31337'`, `'solana'`, `'mina'`. */
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

/** Read an ERC-20 token balance (balance + decimals + symbol) for `owner`. */
export async function readEvmTokenBalance(opts: {
  rpcUrl: string;
  chainKey: string;
  tokenAddress: string;
  owner: string;
}): Promise<WalletBalance> {
  const chainId = parseEvmChainId(opts.chainKey);
  const client = createPublicClient({
    transport: http(opts.rpcUrl),
    chain: defineChain({
      id: chainId,
      name: opts.chainKey,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    }),
  });
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
  rpcUrl: string;
  chainKey: string;
  owner: string;
}): Promise<WalletTokenAmount> {
  const chainId = parseEvmChainId(opts.chainKey);
  const client = createPublicClient({
    transport: http(opts.rpcUrl),
    chain: defineChain({
      id: chainId,
      name: opts.chainKey,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    }),
  });
  const wei = await client.getBalance({ address: opts.owner as `0x${string}` });
  return { symbol: 'ETH', amount: wei.toString(), decimals: 18 };
}

/** Read the native SOL balance (lamports) for `owner` via the `getBalance` RPC. */
export async function readSolanaNativeBalance(opts: {
  rpcUrl: string;
  owner: string;
  fetchImpl?: typeof fetch;
}): Promise<WalletTokenAmount> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(opts.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [opts.owner, { commitment: 'confirmed' }],
    }),
  });
  if (!res.ok) throw new Error(`Solana RPC request failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { value?: number | string };
    error?: { message?: string };
  };
  if (json.error) throw new Error(`Solana RPC error: ${json.error.message ?? 'unknown'}`);
  const lamports = BigInt(json.result?.value ?? 0);
  return { symbol: 'SOL', amount: lamports.toString(), decimals: 9 };
}

/** Read the SPL-token balance for `owner`'s token account(s) of `mint`. */
export async function readSolanaTokenBalance(opts: {
  rpcUrl: string;
  mint: string;
  owner: string;
  fetchImpl?: typeof fetch;
}): Promise<WalletBalance> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(opts.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [opts.owner, { mint: opts.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    }),
  });
  if (!res.ok) throw new Error(`Solana RPC request failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } } }[] };
    error?: { message?: string };
  };
  if (json.error) throw new Error(`Solana RPC error: ${json.error.message ?? 'unknown'}`);
  let amount = 0n;
  let decimals: number | undefined;
  for (const acc of json.result?.value ?? []) {
    const ta = acc.account?.data?.parsed?.info?.tokenAmount;
    if (ta?.amount) amount += BigInt(ta.amount);
    if (ta?.decimals !== undefined) decimals = ta.decimals;
  }
  const out: WalletBalance = { chain: 'solana', address: opts.owner, amount: amount.toString() };
  if (decimals !== undefined) out.assetScale = decimals;
  return out;
}

/** Read the native MINA balance (nanomina) for `owner` via the Mina GraphQL API. */
export async function readMinaBalance(opts: {
  graphqlUrl: string;
  owner: string;
  fetchImpl?: typeof fetch;
}): Promise<WalletBalance> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const query = 'query($pk:String!){account(publicKey:$pk){balance{total}}}';
  const res = await fetchImpl(opts.graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { pk: opts.owner } }),
  });
  if (!res.ok) throw new Error(`Mina GraphQL request failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { account?: { balance?: { total?: string } | null } | null };
    errors?: { message?: string }[];
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Mina GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`);
  }
  return {
    chain: 'mina',
    address: opts.owner,
    amount: String(json.data?.account?.balance?.total ?? '0'),
    asset: 'MINA',
    assetScale: 9,
  };
}

/**
 * Per-chain inputs for {@link readWalletBalances}: the resolved RPC URL, the
 * identity's address on that chain, and the configured token (USDC) — sourced by
 * the caller from the network topology / presets, never hardcoded here. A chain
 * key absent from the object is simply not read.
 */
export interface WalletBalanceSources {
  evm?: { chainKey: string; rpcUrl: string; owner: string; tokenAddress?: string };
  solana?: { chainKey?: string; rpcUrl: string; owner: string; tokenMint?: string };
  mina?: { chainKey?: string; graphqlUrl: string; owner: string };
  /** Injectable fetch (Solana/Mina JSON-RPC & GraphQL) for tests. */
  fetchImpl?: typeof fetch;
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
  const { fetchImpl } = sources;
  const tasks: Promise<WalletChainBalances>[] = [];

  if (sources.evm) {
    const { chainKey, rpcUrl, owner, tokenAddress } = sources.evm;
    tasks.push(
      (async () => {
        const out: WalletChainBalances = { chain: 'evm', chainKey, address: owner, tokens: [] };
        const errors: string[] = [];
        const [nativeR, tokenR] = await Promise.allSettled([
          readEvmNativeBalance({ rpcUrl, chainKey, owner }),
          tokenAddress
            ? readEvmTokenBalance({ rpcUrl, chainKey, tokenAddress, owner })
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
    const { chainKey = 'solana', rpcUrl, owner, tokenMint } = sources.solana;
    tasks.push(
      (async () => {
        const out: WalletChainBalances = { chain: 'solana', chainKey, address: owner, tokens: [] };
        const errors: string[] = [];
        const [nativeR, tokenR] = await Promise.allSettled([
          readSolanaNativeBalance({ rpcUrl, owner, fetchImpl }),
          tokenMint
            ? readSolanaTokenBalance({ rpcUrl, mint: tokenMint, owner, fetchImpl })
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

  if (sources.mina) {
    const { chainKey = 'mina', graphqlUrl, owner } = sources.mina;
    tasks.push(
      (async () => {
        const out: WalletChainBalances = { chain: 'mina', chainKey, address: owner, tokens: [] };
        const errors: string[] = [];
        // Mina's paid asset is native MINA; there is no configured Mina token.
        const nativeR = await Promise.allSettled([readMinaBalance({ graphqlUrl, owner, fetchImpl })]);
        foldNative(
          out,
          nativeR[0].status === 'fulfilled'
            ? {
                status: 'fulfilled',
                value: {
                  symbol: nativeR[0].value.asset,
                  amount: nativeR[0].value.amount,
                  decimals: nativeR[0].value.assetScale,
                },
              }
            : nativeR[0],
          errors
        );
        finalizeChain(out, errors);
        return out;
      })()
    );
  }

  return Promise.all(tasks);
}
