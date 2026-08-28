/**
 * The three EVM contracts this client touches, cut down to the members it
 * actually calls.
 *
 * A partial ABI is deliberate rather than lazy: every entry here is a call this
 * client makes, so the list doubles as the exhaustive statement of what a channel
 * costs its owner on chain. The contracts are
 * `connector/packages/contracts/src/{TokenNetwork,TokenNetworkRegistry}.sol`.
 */

/**
 * `TokenNetwork` — one deployment per settlement token, and the EIP-712
 * `verifyingContract` every claim on a channel of its is signed under.
 *
 * Two members are worth pointing at, because everything the client can do
 * *without* an event log follows from them:
 *
 * - **`channelEpoch(p1, p2)`** is the pair's public, monotonic counter. It
 *   advances only when a channel of theirs settles
 *   (`TokenNetwork.sol`'s `settleChannel`), so a pair has at most one live
 *   channel and its id is a pure function of the pair and this number
 *   ([ADR 0059](https://github.com/toon-protocol/connector/blob/main/docs/adr/0059-a-channel-is-derived-from-its-participants.md)).
 *   That is what lets a client derive its own channel id off chain and *adopt*
 *   an already-open channel instead of opening a second one — see
 *   {@link ./channel-id.js!deriveEvmChannelId}.
 * - **`channels(id)`** answers whether that derived id is at anything.
 *
 * `channelEpoch` is read through a call that is allowed to REVERT. The deployed
 * Base Sepolia `TokenNetwork` at the time of writing still carries ADR 0059's
 * predecessor — a global `channelCounter` — and answers `channelEpoch` with a
 * revert, so a client that treated the revert as fatal could not open a channel
 * on the live devnet at all. {@link ./TokenNetworkClient.js!TokenNetworkClient}
 * falls back to the `ChannelOpened` log in that case.
 */
export const TOKEN_NETWORK_ABI = [
  {
    name: 'openChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'participant2', type: 'address' },
      { name: 'settlementTimeout', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'setTotalDeposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'participant', type: 'address' },
      { name: 'totalDeposit', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'closeChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'settleChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'channels',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'settlementTimeout', type: 'uint256' },
      { name: 'state', type: 'uint8' },
      { name: 'closedAt', type: 'uint256' },
      { name: 'openedAt', type: 'uint256' },
      { name: 'participant1', type: 'address' },
      { name: 'participant2', type: 'address' },
    ],
  },
  {
    name: 'participants',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [
      { name: 'deposit', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'transferredAmount', type: 'uint256' },
    ],
  },
  {
    // Public mapping getter: `mapping(address => mapping(address => uint256))
    // public channelEpoch`, keyed by the SORTED pair.
    name: 'channelEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'ChannelOpened',
    type: 'event',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'participant1', type: 'address', indexed: true },
      { name: 'participant2', type: 'address', indexed: true },
      { name: 'settlementTimeout', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * `TokenNetworkRegistry` — the stable address, and the only authority on which
 * `TokenNetwork` serves a given token.
 *
 * A node publishes both in its self-description, and this client cross-checks
 * them: `getTokenNetwork(tokenAddress)` must equal the published `tokenNetwork`,
 * or a claim would be signed under an EIP-712 `verifyingContract` that no channel
 * of ours lives at. The registry is read rather than trusted because it is the
 * one of the two that cannot be misconfigured — a `TokenNetwork` is *minted* by
 * it (`createTokenNetwork`), so its answer is the definition.
 */
export const TOKEN_NETWORK_REGISTRY_ABI = [
  {
    name: 'getTokenNetwork',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
] as const;

/** ERC-20, cut to the two members collateralising a channel needs. */
export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;
