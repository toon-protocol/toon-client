/**
 * Who pays the gas for a deposit into an x402 `batch-settlement` channel on
 * EVM, and how (connector ADR 0074; toon-client#695).
 *
 * The contract's `deposit(config, amount, collector, collectorData)` is
 * callable by anyone: the payer's one signature — an ERC-3009 authorization or
 * a Permit2 witness transfer — binds the deposit to its channel. So the same
 * signed payload can be put on chain two ways:
 *
 *   - **by a facilitator**, which pays the gas (`facilitator.ts`); or
 *   - **by the payer itself**, from its own ETH ({@link depositDirectly}).
 *
 * Both spend the one authorization, and its nonce is single-use on chain — the
 * ERC-3009 nonce is `keccak256(channelId, salt)`, a Permit2 nonce is
 * unordered and random — so a direct deposit after a facilitator's answer was
 * lost can never land twice: whichever arrives second reverts.
 *
 * A token without ERC-3009 deposits through Permit2, which first needs the
 * payer's `approve(Permit2, …)`. That approval is gas too, and x402 defines
 * two extensions for a facilitator to cover it:
 *
 *   - `eip2612GasSponsoring`, for a token with an EIP-2612 permit: the payer
 *     signs a permit for Permit2 and the facilitator folds it into the deposit;
 *   - `erc20ApprovalGasSponsoring`, for a token with neither: the payer signs
 *     the `approve` transaction without sending it, and the facilitator funds
 *     its gas and broadcasts it before the deposit.
 *
 * A payer holding ETH can instead send the approval itself
 * ({@link approvePermit2}). The encodings below are x402's own
 * (`@x402/evm` 2.27.0, `batch-settlement/encoding.ts` and
 * `shared/extensions`), so a facilitator and a direct deposit read the same
 * bytes.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseErc6492Signature,
  parseSignature,
  type Hex,
  type LocalAccount,
} from 'viem';
import { rpcTransport } from '../../transport/rpc.js';
import {
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_ADDRESS,
  PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
  X402_BATCH_SETTLEMENT_ADDRESS,
  type BatchChannelConfig,
  type BatchDepositPayload,
  type ContractReader,
  type Eip3009DepositPayload,
  type Permit2DepositPayload,
  type TypedDataSigner,
} from './evm.js';
import { NetworkError, TransactionOutcomeError } from '../../client/errors.js';

export const EIP2612_GAS_SPONSORING = 'eip2612GasSponsoring';
export const ERC20_APPROVAL_GAS_SPONSORING = 'erc20ApprovalGasSponsoring';

/** x402's approval gas limit and fallback fee cap (`@x402/evm` 2.27.0). */
export const ERC20_APPROVE_GAS_LIMIT = 70_000n;
const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000n;
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 100_000_000n;

const CHANNEL_CONFIG_COMPONENTS = [
  { name: 'payer', type: 'address' },
  { name: 'payerAuthorizer', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'receiverAuthorizer', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'withdrawDelay', type: 'uint40' },
  { name: 'salt', type: 'bytes32' },
] as const;

/** `x402BatchSettlement.deposit`. */
export const X402_BATCH_SETTLEMENT_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'config', type: 'tuple', components: CHANNEL_CONFIG_COMPONENTS },
      { name: 'amount', type: 'uint128' },
      { name: 'collector', type: 'address' },
      { name: 'collectorData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const ERC20_PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const EIP2612_PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

// ---------------------------------------------------------------------------
// The payer's own chain access
// ---------------------------------------------------------------------------

/**
 * What paying gas from the payer's own wallet needs of the chain, bound to the
 * payer's account. A viem wallet client extended with public actions provides
 * all of it; `ToonClient` builds one lazily.
 */
export interface EvmWalletAccess {
  /** The payer's native balance, wei. */
  getBalance(): Promise<bigint>;
  /** The payer's next transaction nonce. */
  getTransactionCount(): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Sign, without sending, a transaction from the payer's account. */
  signTransaction(transaction: never): Promise<Hex>;
  /** Send a contract call from the payer's account. */
  writeContract(params: never): Promise<Hex>;
  waitForTransactionReceipt(params: { hash: Hex }): Promise<{ status: string }>;
}

/**
 * {@link EvmWalletAccess} for `account` over `rpcUrl`, on whichever chain the
 * RPC reports. Nothing connects until it is first used.
 */
export function evmWalletAccess(params: {
  rpcUrl: string;
  account: LocalAccount;
  /** The proxy-bound dispatcher a hidden payer's RPC rides, if any. */
  dispatcher?: unknown;
}): EvmWalletAccess {
  const { account } = params;
  const transport = rpcTransport(params.rpcUrl, params.dispatcher);
  const reader = createPublicClient({ transport });
  let writer: Promise<ReturnType<typeof createWalletClient>> | undefined;
  const wallet = () =>
    (writer ??= reader.getChainId().then((id) =>
      createWalletClient({
        account,
        transport,
        chain: defineChain({
          id,
          name: `eip155:${id}`,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [params.rpcUrl] } },
        }),
      })
    ));
  return {
    getBalance: () => reader.getBalance({ address: account.address }),
    getTransactionCount: () =>
      reader.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    estimateFeesPerGas: () => reader.estimateFeesPerGas(),
    signTransaction: (tx: never) => account.signTransaction(tx),
    writeContract: async (q: never) => (await wallet()).writeContract(q),
    waitForTransactionReceipt: ({ hash }) => reader.waitForTransactionReceipt({ hash }),
  };
}

// ---------------------------------------------------------------------------
// Reading the token
// ---------------------------------------------------------------------------

/** How much of `token` Permit2 may move for `owner`. */
export async function permit2Allowance(
  reader: ContractReader,
  token: string,
  owner: string
): Promise<bigint> {
  return (await reader.readContract({
    address: getAddress(token),
    abi: ERC20_PERMIT2_ABI,
    functionName: 'allowance',
    args: [getAddress(owner), PERMIT2_ADDRESS],
  } as never)) as bigint;
}

/**
 * `owner`'s EIP-2612 nonce on `token`, or `undefined` when the token has no
 * `nonces(address)` — and so, for this purpose, no permit.
 */
export async function eip2612Nonce(
  reader: ContractReader,
  token: string,
  owner: string
): Promise<bigint | undefined> {
  try {
    return (await reader.readContract({
      address: getAddress(token),
      abi: ERC20_PERMIT2_ABI,
      functionName: 'nonces',
      args: [getAddress(owner)],
    } as never)) as bigint;
  } catch {
    return undefined;
  }
}

/** The extensions a facilitator's `GET /supported` advertises. */
export async function facilitatorExtensions(
  facilitatorUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const url = `${facilitatorUrl.replace(/\/+$/, '')}/supported`;
  let body: unknown;
  try {
    const response = await fetchImpl(url);
    body = await response.json();
  } catch (err) {
    throw new NetworkError(
      `facilitator ${url} did not answer`,
      err instanceof Error ? err : undefined
    );
  }
  const extensions = (body as { extensions?: unknown } | null)?.extensions;
  return Array.isArray(extensions)
    ? extensions.filter((e): e is string => typeof e === 'string')
    : [];
}

// ---------------------------------------------------------------------------
// The two gas-sponsoring extensions, in x402's own shape
// ---------------------------------------------------------------------------

/** `paymentPayload.extensions`, as a facilitator reads them. */
export type DepositExtensions = Record<string, { info: Record<string, unknown> }>;

/**
 * An EIP-2612 permit letting Permit2 move `amount` of the token, for the
 * facilitator to fold into the deposit (`eip2612GasSponsoring`).
 */
export async function signEip2612GasSponsoring(params: {
  payer: TypedDataSigner;
  token: string;
  /** The token's own EIP-712 domain. */
  name: string;
  version: string;
  chainId: number;
  nonce: bigint;
  amount: bigint;
  /** The Permit2 authorization's own deadline, unix seconds. */
  deadline: string;
}): Promise<DepositExtensions> {
  const owner = getAddress(params.payer.address);
  const asset = getAddress(params.token);
  const signature = await params.payer.signTypedData({
    domain: {
      name: params.name,
      version: params.version,
      chainId: params.chainId,
      verifyingContract: asset,
    },
    types: EIP2612_PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner,
      spender: PERMIT2_ADDRESS,
      value: params.amount,
      nonce: params.nonce,
      deadline: BigInt(params.deadline),
    },
  } as never);
  return {
    [EIP2612_GAS_SPONSORING]: {
      info: {
        from: owner,
        asset,
        spender: PERMIT2_ADDRESS,
        amount: params.amount.toString(),
        nonce: params.nonce.toString(),
        deadline: params.deadline,
        signature,
        version: '1',
      },
    },
  };
}

/**
 * The payer's signed-but-unsent `approve(Permit2, max)`, for the facilitator
 * to fund and broadcast (`erc20ApprovalGasSponsoring`).
 */
export async function signErc20ApprovalGasSponsoring(params: {
  payerAddress: string;
  wallet: Pick<EvmWalletAccess, 'getTransactionCount' | 'estimateFeesPerGas' | 'signTransaction'>;
  token: string;
  chainId: number;
}): Promise<DepositExtensions> {
  const asset = getAddress(params.token);
  let maxFeePerGas = DEFAULT_MAX_FEE_PER_GAS;
  let maxPriorityFeePerGas = DEFAULT_MAX_PRIORITY_FEE_PER_GAS;
  try {
    ({ maxFeePerGas, maxPriorityFeePerGas } = await params.wallet.estimateFeesPerGas());
  } catch {
    // x402's own client falls back to its defaults too.
  }
  const signedTransaction = await params.wallet.signTransaction({
    to: asset,
    data: encodeFunctionData({
      abi: ERC20_PERMIT2_ABI,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    }),
    nonce: await params.wallet.getTransactionCount(),
    gas: ERC20_APPROVE_GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId: params.chainId,
    type: 'eip1559',
  } as never);
  return {
    [ERC20_APPROVAL_GAS_SPONSORING]: {
      info: {
        from: getAddress(params.payerAddress),
        asset,
        spender: PERMIT2_ADDRESS,
        amount: maxUint256.toString(),
        signedTransaction,
        version: '1',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Paying the gas yourself
// ---------------------------------------------------------------------------

/** How long a landed approval may take to show on the RPC, and how often to look. */
const VISIBLE_WITHIN_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Approve Permit2 for `token`, for the maximum, from the payer's own ETH.
 *
 * With `seen`, it also waits until the RPC shows the allowance: a public RPC is
 * load-balanced, and a receipt from one backend says nothing about the next.
 * On Base Sepolia, a deposit estimated straight after the receipt reverted
 * `TRANSFER_FROM_FAILED` (#695).
 */
export async function approvePermit2(
  wallet: EvmWalletAccess,
  token: string,
  seen?: { reader: ContractReader; owner: string; atLeast: bigint }
): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: getAddress(token),
    abi: ERC20_PERMIT2_ABI,
    functionName: 'approve',
    args: [PERMIT2_ADDRESS, maxUint256],
  } as never);
  await landed(wallet, hash, 'the Permit2 approval');
  if (seen) {
    const deadline = Date.now() + VISIBLE_WITHIN_MS;
    while ((await permit2Allowance(seen.reader, token, seen.owner)) < seen.atLeast) {
      if (Date.now() >= deadline) {
        throw new NetworkError(
          `the Permit2 approval ${hash} landed, but the RPC did not show it within ${VISIBLE_WITHIN_MS / 1000} s`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  return hash;
}

/** `collectorData` for the ERC-3009 deposit collector. */
export function erc3009CollectorData(payload: Eip3009DepositPayload): Hex {
  const auth = payload.deposit.authorization.erc3009Authorization;
  const { signature } = parseErc6492Signature(auth.signature);
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
    [BigInt(auth.validAfter), BigInt(auth.validBefore), BigInt(auth.salt), signature]
  );
}

/**
 * `collectorData` for the Permit2 deposit collector, optionally carrying an
 * EIP-2612 permit for Permit2 (`eip2612PermitData`, else empty).
 */
export function permit2CollectorData(
  payload: Permit2DepositPayload,
  eip2612PermitData: Hex = '0x'
): Hex {
  const auth = payload.deposit.authorization.permit2Authorization;
  const { signature } = parseErc6492Signature(auth.signature as Hex);
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes' }],
    [BigInt(auth.nonce), BigInt(auth.deadline), signature, eip2612PermitData]
  );
}

/** An EIP-2612 permit as the Permit2 collector reads it. */
export function eip2612PermitData(info: {
  amount: string;
  deadline: string;
  signature: string;
}): Hex {
  const { v, r, s, yParity } = parseSignature(info.signature as Hex);
  return encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint8' },
      { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [BigInt(info.amount), BigInt(info.deadline), Number(v ?? BigInt(27 + (yParity ?? 0))), r, s]
  );
}

/**
 * Put a signed deposit on chain from the payer's own wallet: the same call a
 * facilitator makes, with the payer paying the gas.
 */
export async function depositDirectly(
  wallet: EvmWalletAccess,
  payload: BatchDepositPayload<unknown>,
  method: 'eip3009' | 'permit2'
): Promise<Hex> {
  const config: BatchChannelConfig = payload.channelConfig;
  const collectorData =
    method === 'eip3009'
      ? erc3009CollectorData(payload as Eip3009DepositPayload)
      : permit2CollectorData(payload as Permit2DepositPayload);
  const hash = await wallet.writeContract({
    address: X402_BATCH_SETTLEMENT_ADDRESS,
    abi: X402_BATCH_SETTLEMENT_DEPOSIT_ABI,
    functionName: 'deposit',
    args: [
      {
        payer: getAddress(config.payer),
        payerAuthorizer: getAddress(config.payerAuthorizer),
        receiver: getAddress(config.receiver),
        receiverAuthorizer: getAddress(config.receiverAuthorizer),
        token: getAddress(config.token),
        withdrawDelay: config.withdrawDelay,
        salt: config.salt,
      },
      BigInt((payload.deposit as { amount: string }).amount),
      method === 'eip3009'
        ? ERC3009_DEPOSIT_COLLECTOR_ADDRESS
        : PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
      collectorData,
    ],
  } as never);
  await landed(wallet, hash, 'the deposit');
  return hash;
}

async function landed(wallet: EvmWalletAccess, hash: Hex, what: string): Promise<void> {
  const receipt = await wallet.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new TransactionOutcomeError(`${what} ${hash} reverted`, 'evm', hash, 'failed');
  }
}
