/**
 * Shared MCP tool / resource names for the TOON apps surface.
 *
 * Node-safe (no React) so both the iframe runtime and the server can import them
 * and stay in lockstep.
 */

/** Resolves a NIP-01 filter to events (free read). */
export const QUERY_TOOL = 'toon_query';
/** Returns the atom catalog so the agent can compose valid ViewSpecs. */
export const ATOMS_TOOL = 'toon_atoms';
/** Accepts an agent-authored ViewSpec; carries `_meta.ui.resourceUri`. */
export const RENDER_TOOL = 'toon_render';
/** Pay-to-write: daemon signs + publishes the supplied event shell. */
export const PUBLISH_TOOL = 'toon_publish_unsigned';
/** Spendy: upload media to Arweave then publish a referencing event. */
export const UPLOAD_TOOL = 'toon_upload';
/** Pre-open a payment channel (daemon signs/settles; UI never holds keys). */
export const OPEN_CHANNEL_TOOL = 'toon_open_channel';
/** Spendy: run a cross-asset swap; daemon signs the source claim, returns a target claim. */
export const SWAP_TOOL = 'toon_swap';
/** Read-only: report the current pay-to-write fee + settlement chain (no payment). */
export const STATUS_TOOL = 'toon_status';
/** Read-only: list tracked payment channels with nonce + cumulative + available balance. */
export const CHANNELS_TOOL = 'toon_channels';
/** Read-only: on-chain wallet token balances per configured chain. */
export const BALANCES_TOOL = 'toon_balances';
/** Devnet: drip faucet test funds to a wallet address (receives funds; not spendy). */
export const FUND_WALLET_TOOL = 'toon_fund_wallet';
/** Spendy: deposit additional collateral into an open payment channel (on-chain). */
export const CHANNEL_DEPOSIT_TOOL = 'toon_channel_deposit';

/** The single MCP-app UI resource the host renders. */
export const APP_RESOURCE_URI = 'ui://toon/app';

/** Write tools the runtime/validator permit an action to target. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  PUBLISH_TOOL,
  UPLOAD_TOOL,
  OPEN_CHANNEL_TOOL,
  SWAP_TOOL,
  // Devnet faucet — a write-class action (it mutates wallet funds) but `spendy:
  // false` since it *receives* funds; routed here so the validator permits it.
  FUND_WALLET_TOOL,
  // Channel deposit — spendy (moves on-chain collateral).
  CHANNEL_DEPOSIT_TOOL,
]);
