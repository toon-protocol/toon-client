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

const DEPOSIT_TOTAL_STATE_INDEX = 4;

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
