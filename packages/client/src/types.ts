import type { IlpPeerInfo } from '@toon-protocol/core';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Solana payment-channel parameters supplied via `ToonClientConfig.solanaChannel`.
 *
 * Mirrors the `SolanaChannelConfig` consumed by `OnChainChannelClient`, minus
 * the Ed25519 keypair (derived from the client's `mnemonic`, see
 * `ToonClientConfig.solanaChannel`).
 */
export interface SolanaChannelClientOptions {
  /** Solana JSON-RPC URL used to open the channel + read PDA state. */
  rpcUrl: string;
  /** Deployed payment-channel program id (base58). */
  programId: string;
  /**
   * Default SPL token mint (base58) for PDA derivation. The per-channel
   * negotiated token (the peer's preferred token) takes precedence when present.
   */
  tokenMint?: string;
  /** Challenge-period duration (seconds) for `initialize_channel`. */
  challengeDuration?: number;
  /**
   * Optional on-chain deposit when opening the channel: `amount` in base units
   * (string) drawn from `payerTokenAccount` (the client's funded SPL token
   * account / ATA, base58). When omitted, the channel is opened without a
   * deposit (connector accepts on `opened` status + participant membership).
   */
  deposit?: { amount: string; payerTokenAccount: string };
}

/**
 * Mina payment-channel parameters supplied via `ToonClientConfig.minaChannel`.
 *
 * Mirrors the `MinaChannelConfig` consumed by `OnChainChannelClient`, minus the
 * Mina private key (derived from the client's `mnemonic`, the same key that
 * produces the registered Mina signer — so the channel-open key and the
 * claim-signing key are guaranteed identical).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PHASE-2 STAGE-3: the client's Mina claim now matches connector 3.9.0's
 * `MinaClaimMessage` contract — `{ zkAppAddress, tokenId, balanceCommitment,
 * proof (base64), salt, nonce }`, with the proof a Pallas Schnorr signature over
 * the connector's `Poseidon([balA,balB,salt]) / Poseidon(zkApp.x)` commitment
 * (verified field-by-field against the connector's o1js verify). A
 * Mina-denominated paid publish is ACCEPTED at `validateClaimMessage` and the
 * apex FULFILLs to town. On-chain SETTLE remains gated for non-EVM dynamic
 * hidden-service peers by connector#88 (`No chain configured for peer`).
 * `zkAppAddress` must be a REAL deployed payment-channel zkApp the apex's Mina
 * provider can resolve on-chain (the e2e harness deploys it deterministically).
 * ────────────────────────────────────────────────────────────────────────────
 */
export interface MinaChannelClientOptions {
  /** Mina GraphQL URL used to open the channel + read zkApp state. */
  graphqlUrl: string;
  /** Deployed payment-channel zkApp address (B62 base58). */
  zkAppAddress: string;
  /** Channel settlement timeout in slots for `initializeChannel` (default 86400). */
  challengeDuration?: number;
  /** Mina token id field (decimal string) for `initializeChannel` (default '1'). */
  tokenId?: string;
  /** Optional on-chain deposit (base units, string) after the channel opens. */
  deposit?: { amount: string };
  /** Mina network id for the account/Schnorr prefix (default 'devnet'). */
  networkId?: 'devnet' | 'mainnet';
}

/**
 * Configuration for ToonClient.
 *
 * This story implements HTTP mode only. Embedded mode will be added in a future epic.
 *
 * @example HTTP Mode (implemented)
 * ```typescript
 * const client = new ToonClient({
 *   connectorUrl: 'http://localhost:8080',
 *   secretKey,
 *   ilpInfo: { ilpAddress, btpEndpoint, pubkey },
 *   toonEncoder: encodeEvent,
 *   toonDecoder: decodeEvent,
 * });
 * ```
 *
 * @example Embedded Mode (not yet implemented)
 * ```typescript
 * const client = new ToonClient({
 *   connector: embeddedConnectorInstance,  // Will throw error: "Embedded mode not yet implemented"
 *   secretKey,
 *   ilpInfo,
 *   toonEncoder,
 *   toonDecoder,
 * });
 * ```
 */
export interface ToonClientConfig {
  // ============================================================================
  // CONNECTOR (required for HTTP mode)
  // ============================================================================

  /**
   * HTTP URL of external connector service.
   * Required for HTTP mode.
   * Example: 'http://localhost:8080'
   */
  connectorUrl?: string;

  /**
   * Embedded connector instance - NOT IMPLEMENTED in this story.
   * Will throw error: "Embedded mode not yet implemented in ToonClient."
   * Reserved for future implementation.
   */
  connector?: unknown;

  // ============================================================================
  // IDENTITY (required)
  // ============================================================================

  /**
   * BIP-39 mnemonic phrase to derive a full multi-chain identity from.
   *
   * When provided, the client derives the Nostr (NIP-06) + EVM keys
   * synchronously at construction and the Solana (Ed25519) + Mina (Pallas) keys
   * lazily in `start()`, registering per-chain signers so balance-proof claims
   * can be settled on any of those chains. This is the recommended way to use
   * non-EVM settlement (the raw `secretKey` path is secp256k1-only).
   *
   * Cannot be combined with `secretKey` (ambiguous Nostr identity). May be
   * combined with `evmPrivateKey` to use a separate EVM key (e.g. hardware
   * wallet) while still deriving Solana/Mina from the phrase.
   *
   * SECURITY: JavaScript strings are immutable and cannot be zeroed from
   * memory — the phrase may persist in the heap until GC. Prefer
   * passing a pre-derived `secretKey`/identity in high-security contexts.
   */
  mnemonic?: string;

  /**
   * BIP-44 account index used when deriving the multi-chain identity from
   * `mnemonic`. Defaults to 0 (back-compat). A non-zero index derives a
   * dedicated wallet from a shared mnemonic, producing the SAME addresses as
   * the SDK's `fromMnemonicFull(mnemonic, { accountIndex })`:
   *   - Nostr (secp256k1): m/44'/1237'/0'/0/{index}
   *   - EVM (secp256k1): same key as Nostr
   *   - Solana (Ed25519): m/44'/501'/{index}'/0' (SLIP-0010)
   *   - Mina (Pallas): m/44'/12586'/{index}'/0/0
   *
   * Ignored unless `mnemonic` is provided.
   */
  mnemonicAccountIndex?: number;

  /**
   * 32-byte Nostr private key (hex or Uint8Array).
   * Optional — if omitted, a keypair is auto-generated in applyDefaults()
   * (or derived from `mnemonic` when that is provided instead).
   */
  secretKey?: Uint8Array;

  /** ILP peer information for this client */
  ilpInfo: IlpPeerInfo;

  // ============================================================================
  // TOON ENCODING (required)
  // ============================================================================

  /** Function to encode Nostr events to TOON binary format */
  toonEncoder: (event: NostrEvent) => Uint8Array;

  /** Function to decode TOON binary format to Nostr events */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;

  // ============================================================================
  // EVM IDENTITY (auto-derived, optional override)
  // ============================================================================

  /**
   * EVM private key for signing balance proofs and on-chain transactions.
   *
   * By default, this is derived from `secretKey` — both Nostr and EVM use
   * secp256k1, so a single key provides both identities (matching the SDK's
   * `fromMnemonic()`/`fromSecretKey()` behavior).
   *
   * Only set this if you need a *different* EVM key than your Nostr key
   * (e.g., hardware wallet, custodial key, or legacy key separation).
   */
  evmPrivateKey?: string | Uint8Array;

  // ============================================================================
  // NETWORK TARGETING (optional)
  // ============================================================================

  /**
   * Named network tier. When set (and != `'custom'`), the client defaults all
   * settlement-related config — RPC/GraphQL URLs, supported chain identifiers,
   * preferred tokens, EVM TokenNetwork addresses, and the Solana/Mina channel
   * params (programId / zkApp) — from the shared core presets
   * (`resolveClientNetwork`), so the caller no longer hand-wires every address.
   * This is the client-side mirror of the townhouse node's `network` selector;
   * both resolve the SAME deployed contracts.
   *
   * Precedence: any explicit per-chain field (`supportedChains`,
   * `chainRpcUrls`, `settlementAddresses`, `preferredTokens`, `tokenNetworks`,
   * `solanaChannel`, `minaChannel`) you also pass OVERRIDES the preset for that
   * field. `'custom'` keeps the fully-manual path (no preset defaults). When
   * unset, behaviour is unchanged (fully backward compatible).
   *
   * - `mainnet` — Base mainnet + public Solana/Mina (TOON contracts not yet
   *   deployed → settlement unconfigured, relay-only).
   * - `testnet` / `devnet` — Base Sepolia + Solana/Mina devnet with the LIVE
   *   deployed TOON settlement contracts.
   */
  network?: 'mainnet' | 'testnet' | 'devnet' | 'custom';

  // ============================================================================
  // SETTLEMENT PREFERENCES (optional)
  // ============================================================================

  /** Supported settlement chain identifiers (e.g., ["evm:anvil:31337"]) */
  supportedChains?: string[];

  /** Maps chain identifier to EVM settlement address */
  settlementAddresses?: Record<string, string>;

  /** Maps chain identifier to preferred token contract address */
  preferredTokens?: Record<string, string>;

  /** Maps chain identifier to TokenNetwork contract address (EVM only) */
  tokenNetworks?: Record<string, string>;

  // ============================================================================
  // BTP TRANSPORT (optional)
  // ============================================================================

  /** BTP WebSocket URL (e.g., "ws://localhost:3000") */
  btpUrl?: string;

  /** Auth token for BTP handshake */
  btpAuthToken?: string;

  /** Peer ID for BTP connection (used in connector env var BTP_PEER_{ID}_SECRET) */
  btpPeerId?: string;

  /**
   * ILP-over-HTTP one-shot endpoint of the uplink connector (the `POST /ilp`
   * URL, e.g. "http://localhost:3000/ilp"). When set, the client prefers the
   * stateless {@link HttpIlpClient} transport for one-shot writes instead of
   * opening a persistent BTP WebSocket.
   *
   * This mirrors the `httpEndpoint` field a peer advertises in discovery
   * (`IlpPeerInfo`, toon PR #29). It is surfaced here as explicit config so the
   * default runtime can opt into ILP-over-HTTP before connectors advertise the
   * field on-wire. Leave unset to keep the existing BTP-only behavior (the safe
   * default — no connector advertises an httpEndpoint until the connector + a
   * core release with these fields ship).
   */
  connectorHttpEndpoint?: string;

  /**
   * Whether the uplink connector accepts a BTP `Upgrade` over its HTTP endpoint
   * (mirrors `IlpPeerInfo.supportsUpgrade`, toon PR #29). Only consulted when
   * `connectorHttpEndpoint` is set and a duplex session is required. Defaults to
   * false (no upgrade) when omitted.
   */
  connectorSupportsUpgrade?: boolean;

  /**
   * ILP destination address for event publishing.
   * Defaults to the connector's local address (derived from connectorUrl host).
   * For multi-hop routing, set this to the target node's ILP address.
   * Examples:
   * - 'g.toon.genesis' - Publish to genesis node
   * - 'g.toon.peer1' - Publish to peer1 node
   */
  destinationAddress?: string;

  // ============================================================================
  // ON-CHAIN INTERACTION (optional)
  // ============================================================================

  /** Maps chain identifier to RPC URL (e.g., {"evm:anvil:31337": "http://localhost:8545"}) */
  chainRpcUrls?: Record<string, string>;

  /** Amount to deposit when opening channel (default: "0") */
  initialDeposit?: string;

  /** Challenge period in seconds (default: 86400) */
  settlementTimeout?: number;

  /**
   * Solana payment-channel parameters for opening a REAL on-chain channel and
   * signing a connector-format Solana balance proof.
   *
   * When present (and the client has a Solana signer — i.e. it was constructed
   * from a `mnemonic`), `ToonClient.start()` wires these into the on-chain
   * channel client so that negotiating a `solana:*` chain opens an on-chain
   * channel at the connector-parity PDA and pays a Solana-denominated claim.
   *
   * The Ed25519 keypair is NOT carried here — it is derived from the same
   * `mnemonic` that produces the Solana signer, so the channel-open key and the
   * claim-signing key are guaranteed identical.
   */
  solanaChannel?: SolanaChannelClientOptions;

  /**
   * Mina payment-channel parameters (graphqlUrl + zkAppAddress). When present
   * (and the client has a Mina signer — i.e. it was constructed from a
   * `mnemonic` AND `mina-signer` is installed), `ToonClient.start()` wires these
   * into the on-chain channel client so negotiating a `mina:*` chain routes
   * through `openMinaChannel` and pays a Mina-denominated claim.
   *
   * The Mina private key is NOT carried here — it is derived from the same
   * `mnemonic` that produces the Mina signer.
   *
   * NOTE (Phase-2 Stage-3 gate): see `MinaChannelClientOptions` — supplying this
   * wires the negotiation path but the resulting claim does not yet satisfy
   * connector 3.9.0's Mina claim contract, so a live loop is claim-validation
   * gated (distinct from the connector #88 on-chain-settle gate).
   */
  minaChannel?: MinaChannelClientOptions;

  // ============================================================================
  // PERSISTENCE (optional)
  // ============================================================================

  /** File path for persisting payment channel nonce/amount state across restarts */
  channelStorePath?: string;

  // ============================================================================
  // TRANSPORT PRIVACY (optional)
  // ============================================================================

  /**
   * Transport configuration for privacy-preserving connections.
   *
   * - `direct` (default): No privacy overlay, connect directly.
   * - `socks5`: Route connections through a SOCKS5 proxy (Node.js only).
   *   Requires `socks5h://` scheme for DNS leak prevention.
   * - `gateway`: Route connections through an ator gateway URL (browser-compatible).
   *   The gateway proxies through ator server-side.
   */
  transport?: ClientTransportConfig;

  /**
   * Self-managed `anon` (anyone-protocol / ATOR) SOCKS5h proxy (Node.js only).
   *
   * When the `btpUrl` host ends in `.anyone` and NO explicit proxy is configured
   * (`transport.socksProxy` / `transport.type === 'gateway'`) and the
   * `ANYONE_PROXY_URLS` env var is unset, the SDK auto-downloads + spawns its own
   * `anon` daemon, waits for it to bootstrap + bind a loopback SOCKS5 port, and
   * routes BTP/HTTP through it — ZERO manual proxy setup. `client.stop()` tears
   * the daemon down.
   *
   * - `undefined` (default): auto — managed proxy starts for `.anyone` hosts.
   * - `false`: opt out — never auto-start (you must supply your own proxy).
   *
   * Ignored in browser bundles (the node-only daemon module is never loaded).
   */
  managedAnonProxy?: boolean;

  /** Loopback SOCKS port the managed `anon` daemon binds. Default 9050. */
  managedAnonSocksPort?: number;

  // ============================================================================
  // NETWORK (optional with defaults)
  // ============================================================================

  /** Nostr relay URL for peer discovery. Default: 'ws://localhost:7100' */
  relayUrl?: string;

  /**
   * Known peers to bootstrap with.
   * If provided, these peers will be used for initial bootstrap.
   * DiscoveryTracker will discover additional peers from kind:10032 events after bootstrap.
   */
  knownPeers?: {
    pubkey: string;
    relayUrl: string;
    btpEndpoint?: string;
  }[];

  // ============================================================================
  // TIMEOUTS & RETRIES (optional with defaults)
  // ============================================================================

  /** Query timeout in milliseconds. Default: 30000 */
  queryTimeout?: number;

  /** Maximum number of retries for failed operations. Default: 3 */
  maxRetries?: number;

  /** Delay between retries in milliseconds. Default: 1000 */
  retryDelay?: number;
}

/**
 * Result returned by ToonClient.start()
 */
export interface ToonStartResult {
  /** Number of peers discovered during bootstrap */
  peersDiscovered: number;

  /** Mode the client is running in */
  mode: 'http' | 'embedded';
}

/**
 * Result returned by ToonClient.publishEvent()
 */
export interface PublishEventResult {
  /** Whether the event was successfully published */
  success: boolean;

  /** ID of the published event */
  eventId?: string;

  /** FULFILL response data (base64-encoded), e.g. Arweave tx ID from DVM */
  data?: string;

  /** Error message if success is false */
  error?: string;
}

/**
 * Parameters for signing a balance proof.
 */
export interface BalanceProofParams {
  /** Payment channel identifier */
  channelId: string;
  /** Monotonically increasing nonce */
  nonce: number;
  /** Cumulative amount transferred */
  transferredAmount: bigint;
  /** Amount locked in pending transfers */
  lockedAmount: bigint;
  /** Merkle root of pending lock hashes */
  locksRoot: string;
}

/**
 * A signed balance proof with EIP-712 signature.
 */
export interface SignedBalanceProof extends BalanceProofParams {
  /** EIP-712 signature */
  signature: string;
  /** Address of the signer */
  signerAddress: string;
  /** Chain ID used in EIP-712 domain (e.g. 421614 for Arb Sepolia) */
  chainId: number;
  /** TokenNetwork contract address used in EIP-712 domain */
  tokenNetworkAddress: string;
  /** ERC-20 token address (e.g. USDC) for self-describing claim verification */
  tokenAddress?: string;
  /**
   * Counterparty settlement address the balance proof is bound to.
   *
   * Required for Solana/Mina, where the canonical balance-proof message folds
   * the recipient in (`balanceProofHashSolana` / `balanceProofFieldsMina`).
   * Unused for the client's EVM path (EIP-712 `BalanceProof` has no recipient
   * term). Carried here so it flows from signing through to `buildClaimMessage`.
   */
  recipient?: string;

  /**
   * Mina payment-channel claim fields (connector 3.9.0 `MinaClaimMessage`).
   *
   * Populated only by {@link MinaSigner}, which produces the connector's
   * `Poseidon([balA,balB,salt])` balance commitment + a Pallas Schnorr `proof`
   * over `[commitment, Field(nonce), Poseidon(zkApp.x)]` rather than reusing the
   * generic `signature` field. Carried so they flow from signing through to
   * `MinaSigner.buildClaimMessage`. Absent for EVM/Solana.
   */
  mina?: {
    /** `Poseidon([balanceA, balanceB, salt]).toString()`. */
    balanceCommitment: string;
    /** base64-encoded JSON proof `{ commitment, signature: { r, s }, nonce, signerPublicKey }`. */
    proof: string;
    /** Decimal salt string. */
    salt: string;
    /** Mina token id (default `'MINA'`). */
    tokenId: string;
  };
}

/**
 * Transport configuration for privacy-preserving connections.
 *
 * Node.js: Use `socks5` to route WebSocket and HTTP through a SOCKS5 proxy.
 * Browser: Use `gateway` to route through a server-side ator gateway.
 */
export type ClientTransportConfig =
  | { type: 'direct' }
  | {
      type: 'socks5';
      /** SOCKS5 proxy URL. MUST use `socks5h://` scheme (DNS leak prevention). */
      socksProxy: string;
    }
  | {
      type: 'gateway';
      /** Gateway base URL that proxies connections through ator server-side. */
      gatewayUrl: string;
    };
