/**
 * Read a Mina payment-channel zkApp's on-chain `depositTotal` via a plain
 * GraphQL query (no o1js / WASM). Used by {@link MinaSigner} to bind the
 * conserved `balanceB = depositTotal − balanceA` commitment that a FUNDED zkApp
 * requires (connector#133); without it the connector's `claimFromChannel`
 * verification rejects the claim with `F06 - Invalid zk-SNARK proof on claim`.
 *
 * The `PaymentChannel` zkApp app-state field order is
 * `[channelHash, balanceCommitment, nonceField, channelState, depositTotal, …]`
 * (see `mina-channel-open.ts`), so `depositTotal` is `zkappState[4]`.
 */

/** GraphQL response shape (only the fields we read). */
interface AccountStateResponse {
  data?: { account?: { zkappState?: string[] | null } | null } | null;
  errors?: { message: string }[];
}

/**
 * `PaymentChannel` zkApp app-state field order (see `mina-channel-open.ts` and
 * the zkApp's `@state` declarations in `@toon-protocol/mina-zkapp`):
 *   [0] channelHash, [1] balanceCommitment, [2] nonceField, [3] channelState,
 *   [4] depositTotal, [5] closedAtSlot, [6] settlementTimeout, [7] tokenId_.
 */
const CHANNEL_STATE_INDEX = {
  channelHash: 0,
  balanceCommitment: 1,
  nonceField: 2,
  channelState: 3,
  depositTotal: 4,
} as const;

const DEPOSIT_TOTAL_STATE_INDEX = CHANNEL_STATE_INDEX.depositTotal;

/**
 * Query `account(publicKey).zkappState` and return the channel's `depositTotal`
 * (base units). Throws when the account/state is unavailable so callers can fall
 * back to the legacy `balanceB = 0` behavior.
 *
 * @param fetchImpl - injectable for tests; defaults to global `fetch`.
 */
export async function readMinaDepositTotal(
  graphqlUrl: string,
  zkAppAddress: string,
  fetchImpl: typeof fetch = fetch
): Promise<bigint> {
  const query = 'query($pk:String!){account(publicKey:$pk){zkappState}}';
  const res = await fetchImpl(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { pk: zkAppAddress } }),
  });
  if (!res.ok) {
    throw new Error(`Mina GraphQL request failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as AccountStateResponse;
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `Mina GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`
    );
  }
  const state = json.data?.account?.zkappState;
  if (!state || state.length <= DEPOSIT_TOTAL_STATE_INDEX) {
    throw new Error(
      `Mina zkApp ${zkAppAddress} has no readable zkappState (account not found or not a zkApp)`
    );
  }
  return BigInt(state[DEPOSIT_TOTAL_STATE_INDEX] as string);
}

/** Channel-lifecycle enum written to `channelState` (matches the zkApp). */
export const MINA_CHANNEL_STATE = {
  UNINITIALIZED: 0,
  OPEN: 1,
  CLOSING: 2,
  SETTLED: 3,
} as const;

/**
 * On-chain `PaymentChannel` state the receive-side settler needs to assemble a
 * co-signed `claimFromChannel` — all read via plain GraphQL (NO o1js / WASM), so
 * the read path stays lightweight and unit-testable. Field semantics match
 * {@link MinaChannelState} in the connector's Mina SDK.
 */
export interface MinaOnChainChannelState {
  /** `Poseidon([participantA.x, participantB.x, channelNonce])`, decimal Field. */
  channelHash: string;
  /** Current `Poseidon([balanceA, balanceB, salt])`, decimal Field. */
  balanceCommitment: string;
  /** Highest claimed nonce recorded on-chain. */
  nonceField: bigint;
  /** {@link MINA_CHANNEL_STATE} enum value. */
  channelState: number;
  /** Total escrowed deposit (base units). */
  depositTotal: bigint;
}

/**
 * Read the channel's on-chain `PaymentChannel` state via GraphQL.
 *
 * Reuses the same `account(publicKey).zkappState` query as
 * {@link readMinaDepositTotal} and decodes the fields the co-signed
 * `claimFromChannel` assembly binds: `channelHash` (participant identity),
 * `depositTotal` (balance conservation), `nonceField` (monotonicity gate), and
 * `channelState` (must be OPEN). No o1js is loaded — the values are raw Field
 * decimal strings straight off the node.
 *
 * @param fetchImpl - injectable for tests; defaults to global `fetch`.
 */
export async function readMinaChannelState(
  graphqlUrl: string,
  zkAppAddress: string,
  fetchImpl: typeof fetch = fetch
): Promise<MinaOnChainChannelState> {
  const query = 'query($pk:String!){account(publicKey:$pk){zkappState}}';
  const res = await fetchImpl(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { pk: zkAppAddress } }),
  });
  if (!res.ok) {
    throw new Error(`Mina GraphQL request failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as AccountStateResponse;
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `Mina GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`
    );
  }
  const state = json.data?.account?.zkappState;
  if (!state || state.length <= DEPOSIT_TOTAL_STATE_INDEX) {
    throw new Error(
      `Mina zkApp ${zkAppAddress} has no readable zkappState (account not found or not a zkApp)`
    );
  }
  return {
    channelHash: String(state[CHANNEL_STATE_INDEX.channelHash]),
    balanceCommitment: String(state[CHANNEL_STATE_INDEX.balanceCommitment]),
    nonceField: BigInt(state[CHANNEL_STATE_INDEX.nonceField] as string),
    channelState: Number(state[CHANNEL_STATE_INDEX.channelState]),
    depositTotal: BigInt(state[CHANNEL_STATE_INDEX.depositTotal] as string),
  };
}
