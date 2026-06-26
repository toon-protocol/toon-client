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
