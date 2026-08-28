/**
 * Well-known values for the public TOON devnet.
 *
 * **These are conveniences, never authorities.** Every settlement fact a client
 * actually pays against — the chain, the counterparty address, the token
 * network, the mint, the decimals — comes from the connector's own `GET /ilp`,
 * because the connector proved each of them against a live chain when it booted
 * (`self-description-spec.md` ND-07). Two declarations of one fact is how a
 * mainnet node comes to be described as devnet, so nothing here is ever
 * consulted in preference to the document a node answers with.
 *
 * What they are good for: a default RPC endpoint, a default faucet, and a URL to
 * put in an example so it can be run rather than adapted.
 *
 * Everything below is a **testnet**. Base Sepolia and Solana devnet carry no
 * real value, and the USDC is a mock mint anyone can draw from the faucet.
 */

/** A connector on the public devnet. */
export interface DevnetNode {
  /** Client-edge base URL — `GET /ilp` here returns everything else. */
  url: string;
  /** The route this node terminates. */
  route: string;
  /** That route's flat price, in base units of the settlement asset (USDC, 6dp). */
  price: bigint;
  /** Set when the route accepts only one carriage. */
  requiredTransport?: 'http' | 'btp';
}

export const DEVNET = {
  /**
   * The store node: an Arweave-backed object store behind `g.toon.ario`, priced
   * at 1000 base units (0.001 USDC) and reachable over either carriage.
   */
  store: {
    url: 'https://proxy.ario.devnet.toonprotocol.dev',
    route: 'g.toon.ario',
    price: 1000n,
  } satisfies DevnetNode,

  /**
   * The relay node behind `g.toon.relay`, priced at 1 base unit. Its route is
   * pinned to **BTP**: an HTTP one-shot to it is refused with the same terms
   * document an unpaid request gets, carrying `extra.requiredTransport`.
   */
  relay: {
    url: 'https://proxy.relay.devnet.toonprotocol.dev',
    route: 'g.toon.relay',
    price: 1n,
    requiredTransport: 'btp',
  } satisfies DevnetNode,


  /** Test funds. `POST /api/base-sepolia/request` and `/api/solana/usdc-request`. */
  faucet: 'https://faucet.devnet.toonprotocol.dev',

  /** Base Sepolia. The registry is the stable address; the token network is resolved from it. */
  evm: {
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    tokenNetworkRegistry: '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1',
    tokenNetwork: '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
    /** Mock USDC, 6 decimals, ungated `mint()`. */
    tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
    decimals: 6,
  },

  /** Solana devnet — the public cluster, not a local validator. */
  solana: {
    rpcUrl: 'https://api.devnet.solana.com',
    /** The deployed `payment-channel` program. Bound into every claim (ADR 0053). */
    programId: '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip',
    /** Mock USDC SPL mint, 6 decimals. */
    tokenAddress: 'xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in',
    decimals: 6,
  },
} as const;

/** The default RPC URL for a chain when a caller configures none. */
export function defaultRpcUrl(chain: 'evm' | 'solana'): string {
  return chain === 'evm' ? DEVNET.evm.rpcUrl : DEVNET.solana.rpcUrl;
}
