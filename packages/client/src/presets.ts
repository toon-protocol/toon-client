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
  /** That route's base price, in base units of the settlement asset (USDC, 6dp). */
  price: bigint;
  /**
   * Added per kibibyte of sealed payload, on a route that meters by size. A
   * packet on such a route always costs strictly more than `price`.
   */
  pricePerKib?: bigint;
  /** Set when the route accepts only one carriage. */
  requiredTransport?: 'http' | 'btp';
}

export const DEVNET = {
  /**
   * The store node: an Arweave-backed object store behind `g.toon.store`, and
   * the one route here that METERS — 1000 base units (0.001 USDC) plus 10 per
   * kibibyte of sealed payload, so no packet on it costs only `price`.
   */
  store: {
    url: 'https://proxy.ario.devnet.toonprotocol.dev',
    route: 'g.toon.store',
    price: 1000n,
    pricePerKib: 10n,
  } satisfies DevnetNode,

  /**
   * The gas station behind `g.toon.gas`, priced flat at 1000 base units.
   * Reachable directly, or through the relay at `g.toon.relay.gas`.
   */
  gas: {
    url: 'https://proxy.gas.devnet.toonprotocol.dev',
    route: 'g.toon.gas',
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

  /**
   * The relay's ephemeral lane, priced at **zero** — the one route on the devnet
   * that exercises the whole wire while holding no funds and no channel. Not
   * carriage-pinned, unlike `g.toon.relay` beside it.
   */
  ephemeral: {
    url: 'https://proxy.relay.devnet.toonprotocol.dev',
    route: 'g.toon.relay.ephemeral',
    price: 0n,
  } satisfies DevnetNode,

  /** Test funds. `POST /api/base-sepolia/request` and `/api/solana/usdc-request`. */
  faucet: 'https://faucet.devnet.toonprotocol.dev',

  /** Base Sepolia. The registry is the stable address; the token network is resolved from it. */
  evm: {
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    tokenNetworkRegistry: '0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5',
    tokenNetwork: '0xe9E05dfecfe165266C88d73e61D483612651952a',
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
    tokenAddress: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU',
    decimals: 6,
  },
} as const;

/** The default RPC URL for a chain when a caller configures none. */
export function defaultRpcUrl(chain: 'evm' | 'solana'): string {
  return chain === 'evm' ? DEVNET.evm.rpcUrl : DEVNET.solana.rpcUrl;
}
