/**
 * Scripts-local settlement-chain + transport helpers for the townhouse HS
 * E2E harnesses (`all-three-nodes-hs-LOCAL.ts`, `social-flow-hs-LOCAL.ts`,
 * `mill-swap-hs-LOCAL.ts`).
 *
 * THIS IS HARNESS WIRING, NOT LIBRARY CODE. It lives under `scripts/` and is
 * never published — it only orchestrates the already-shipped client library
 * (`EvmSigner` / `SolanaSigner` / `MinaSigner`, `OnChainChannelClient`,
 * `deriveFullIdentity`, `BtpRuntimeClient`).
 *
 * Two axes:
 *
 *   1. `resolveSettlement(env)` — selects the SETTLEMENT chain
 *      (`SETTLEMENT_CHAIN ∈ {evm,solana,mina}`) the client→apex payment channel
 *      and per-packet claims use. Returns the chain key, an opener-params
 *      builder, a per-cumulative `buildClaim()` closure (chain-dispatched), and
 *      the apex settlement address the proof binds to. EVM is the default and
 *      reproduces the legacy single-chain behaviour byte-for-byte.
 *
 *   2. `resolveBtpTransport(env)` — picks the BTP transport: the existing
 *      SOCKS5 path (default) OR a DIRECT plain-`ws://` apex when `DIRECT_BTP=1`
 *      / `APEX_BTP_URL` is set. The SOCKS path is preserved unchanged.
 *
 *   3. `resolveRelayTransport(env)` — picks the Nostr-relay READ/SUBSCRIBE
 *      transport. Reads are FREE (no payment), so the default is DIRECT: a plain
 *      `ws://<relay-host>:7100` dialed with the native `ws` socket (no SOCKS
 *      agent). ATOR/SOCKS is OPT-IN: set `RELAY_SOCKS_PROXY` (or `SOCKS_PROXY`
 *      together with a `.anyone`/`.anon` relay URL) to route to the relay's
 *      hidden service through a SOCKS5 agent (the legacy behaviour). Mirrors the
 *      direct-by-default / SOCKS-optional shape of `resolveBtpTransport`.
 *
 * Config is read from env (the harnesses also overlay a handoff JSON; they pass
 * the merged values in via the `env`-shaped object).
 */
import WsWebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { EvmSigner } from '../../src/signing/evm-signer.js';
import { SolanaSigner } from '../../src/signing/solana-signer.js';
import { MinaSigner } from '../../src/signing/mina-signer.js';
import { OnChainChannelClient } from '../../src/channel/OnChainChannelClient.js';
import {
  deriveFullIdentity,
  generateMnemonic,
} from '../../src/keys/KeyDerivation.js';
import type { ClaimMessage } from '../../src/signing/types.js';
import type { OpenChannelParams } from '@toon-protocol/core';

export type SettlementChain = 'evm' | 'solana' | 'mina';

/** The minimal env surface the resolvers read (so callers can overlay a handoff). */
export type SettlementEnv = Record<string, string | undefined>;

/** A per-cumulative, chain-dispatched claim builder. */
export type BuildClaim = (
  cumulative: bigint,
  nonce: number
) => Promise<ClaimMessage>;

export interface ResolvedSettlement {
  /** Which chain was selected. */
  chain: SettlementChain;
  /** Negotiated chain key e.g. `evm:base:31337` / `solana:devnet` / `mina:devnet`. */
  chainKey: string;
  /** Apex settlement address (EVM 0x / Solana base58 / Mina B62) — claim recipient + channel peer. */
  apexSettlementAddress: string;
  /**
   * The on-chain channel client, pre-configured for the selected chain
   * (`setSolanaConfig` / `setMinaConfig` already applied for non-EVM).
   */
  channelClient: OnChainChannelClient;
  /** Open the client→apex channel on the selected chain; returns the channel id. */
  openChannel: () => Promise<string>;
  /**
   * Build a cumulative-balance claim for the (already-opened) channel. MUST be
   * called after `openChannel()` — the channel id is captured internally.
   */
  buildClaim: BuildClaim;
  /** The sender's Nostr pubkey (senderId carried in every claim). */
  nostrPubkey: string;
  /** The sender's Nostr secret key (for event signing / swap gift-wrap). */
  nostrSecretKey: Uint8Array;
  /** EVM address of the funding account (for logging / balance reads). */
  evmAddress: string;
}

/**
 * Read the on-chain Mina channel `depositTotal` (zkApp `zkappState` slot 4:
 * `[balanceCommitmentA, balanceCommitmentB, nonceField, channelState,
 * depositTotal, ...]`) straight from the GraphQL node. Used at claim time so the
 * client binds the same conserved `balanceB = depositTotal − balanceA` the
 * connector derives from on-chain state (connector#133). Returns 0n if the
 * account/state is unavailable (signer then falls back to the legacy form).
 */
async function readMinaDepositTotal(
  graphqlUrl: string,
  zkAppAddress: string
): Promise<bigint> {
  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ account(publicKey: "${zkAppAddress}") { zkappState } }`,
      }),
    });
    const json = (await res.json()) as {
      data?: { account?: { zkappState?: string[] | null } | null };
    };
    const state = json.data?.account?.zkappState;
    return state && state[4] != null ? BigInt(state[4]) : 0n;
  } catch {
    return 0n;
  }
}

const ZERO_LOCKS_ROOT = `0x${'00'.repeat(32)}`;

/** Parse the `evm:{net}:{chainId}` key into its numeric chain id. */
function evmChainId(chainKey: string): number {
  const id = Number(chainKey.split(':')[2]);
  if (!Number.isFinite(id)) {
    throw new Error(
      `SETTLEMENT_CHAIN=evm requires a numeric chain id in chainKey "${chainKey}"`
    );
  }
  return id;
}

/**
 * Resolve the EVM settlement branch (DEFAULT). Reproduces the legacy hardcoded
 * behaviour: an `EvmSigner` from the client privkey, an EVM channel against the
 * MockUSDC TokenNetwork, and `EvmSigner.buildClaimMessage`.
 */
function resolveEvm(
  env: SettlementEnv,
  ctx: {
    nostrPubkey: string;
    nostrSecretKey: Uint8Array;
    evmPrivKey: string;
    anvilRpc: string;
    mockUsdc: string;
    tokenNetwork: string;
    apexEvm: string;
    deposit: string;
  }
): ResolvedSettlement {
  const chainKey = env['EVM_CHAIN_KEY']?.trim() || 'evm:base:31337';
  const chainId = evmChainId(chainKey);
  const evmSigner = new EvmSigner(ctx.evmPrivKey);
  const channelClient = new OnChainChannelClient({
    evmSigner,
    chainRpcUrls: { [chainKey]: ctx.anvilRpc },
  });

  let channelId = '';

  const params: OpenChannelParams = {
    peerId: 'apex',
    chain: chainKey,
    tokenNetwork: ctx.tokenNetwork,
    token: ctx.mockUsdc,
    peerAddress: ctx.apexEvm,
    initialDeposit: ctx.deposit,
    settlementTimeout: 86400,
  };

  return {
    chain: 'evm',
    chainKey,
    apexSettlementAddress: ctx.apexEvm,
    channelClient,
    evmAddress: evmSigner.address,
    nostrPubkey: ctx.nostrPubkey,
    nostrSecretKey: ctx.nostrSecretKey,
    openChannel: async () => {
      const open = await channelClient.openChannel(params);
      channelId = open.channelId;
      return channelId;
    },
    buildClaim: async (cumulative, nonce) => {
      if (!channelId)
        throw new Error('openChannel() must run before buildClaim()');
      const proof = await evmSigner.signBalanceProof({
        channelId,
        nonce,
        transferredAmount: cumulative,
        lockedAmount: 0n,
        locksRoot: ZERO_LOCKS_ROOT,
        chainId,
        tokenNetworkAddress: ctx.tokenNetwork,
        tokenAddress: ctx.mockUsdc,
      });
      return EvmSigner.buildClaimMessage(proof, ctx.nostrPubkey);
    },
  };
}

/**
 * Resolve the Solana settlement branch. Derives the Ed25519 seed from the
 * mnemonic via `deriveFullIdentity`, registers a `SolanaSigner`, injects
 * `setSolanaConfig`, opens a real on-chain PDA channel, and signs the
 * connector's 48-byte payment-channel balance proof.
 */
async function resolveSolana(
  env: SettlementEnv,
  ctx: {
    nostrPubkey: string;
    nostrSecretKey: Uint8Array;
    evmPrivKey: string;
    mnemonic: string;
    deposit: string;
  }
): Promise<ResolvedSettlement> {
  const chainKey = env['SOLANA_CHAIN_KEY']?.trim() || 'solana:devnet';
  const rpcUrl = env['SOLANA_RPC_URL']?.trim();
  const programId = env['SOLANA_PROGRAM_ID']?.trim();
  const tokenMint =
    env['SOLANA_TOKEN_MINT']?.trim() || env['SOLANA_USDC_MINT']?.trim();
  const apexSolana =
    env['APEX_SOLANA_PUBKEY']?.trim() ||
    env['TARGET_SETTLEMENT_ADDRESS_SOLANA']?.trim();
  const payerTokenAccount = env['SOLANA_PAYER_TOKEN_ACCOUNT']?.trim();
  const depositAmount = env['SOLANA_DEPOSIT_AMOUNT']?.trim() || ctx.deposit;

  if (!rpcUrl)
    throw new Error('SETTLEMENT_CHAIN=solana requires SOLANA_RPC_URL');
  if (!programId)
    throw new Error('SETTLEMENT_CHAIN=solana requires SOLANA_PROGRAM_ID');
  if (!tokenMint)
    throw new Error(
      'SETTLEMENT_CHAIN=solana requires SOLANA_TOKEN_MINT (or SOLANA_USDC_MINT)'
    );
  if (!apexSolana)
    throw new Error(
      'SETTLEMENT_CHAIN=solana requires the apex Solana settlement pubkey ' +
        '(APEX_SOLANA_PUBKEY or TARGET_SETTLEMENT_ADDRESS_SOLANA) — the claim ' +
        'recipient and channel peer'
    );

  const identity = await deriveFullIdentity(ctx.mnemonic);
  if (!identity.solana.publicKey) {
    throw new Error(
      'Solana key derivation failed (missing @noble/curves) — cannot settle on Solana'
    );
  }
  // 32-byte signing seed (deriveFullIdentity emits a 64-byte secretKey).
  const seed = identity.solana.secretKey.slice(0, 32);
  const solanaSigner = new SolanaSigner(seed, identity.solana.publicKey);

  const evmSigner = new EvmSigner(ctx.evmPrivKey);
  const channelClient = new OnChainChannelClient({
    evmSigner,
    chainRpcUrls: {},
  });
  channelClient.setSolanaConfig({
    rpcUrl,
    programId,
    tokenMint,
    keypair: identity.solana.secretKey,
    ...(depositAmount && payerTokenAccount
      ? { deposit: { amount: depositAmount, payerTokenAccount } }
      : {}),
  });

  let channelId = '';
  const params: OpenChannelParams = {
    peerId: 'apex',
    chain: chainKey,
    token: tokenMint,
    peerAddress: apexSolana,
    settlementTimeout: 86400,
  };

  return {
    chain: 'solana',
    chainKey,
    apexSettlementAddress: apexSolana,
    channelClient,
    evmAddress: evmSigner.address,
    nostrPubkey: ctx.nostrPubkey,
    nostrSecretKey: ctx.nostrSecretKey,
    openChannel: async () => {
      const open = await channelClient.openChannel(params);
      channelId = open.channelId;
      return channelId;
    },
    buildClaim: async (cumulative, nonce) => {
      if (!channelId)
        throw new Error('openChannel() must run before buildClaim()');
      const proof = await solanaSigner.signBalanceProof({
        channelId,
        nonce,
        transferredAmount: cumulative,
        lockedAmount: 0n,
        locksRoot: ZERO_LOCKS_ROOT,
        recipient: apexSolana,
        metadata: { chainType: 'solana', programId, tokenMint },
      });
      return solanaSigner.buildClaimMessage(proof, ctx.nostrPubkey);
    },
  };
}

/**
 * Resolve the Mina settlement branch. Derives the Pallas key from the mnemonic,
 * constructs a `MinaSigner` **with the apex Mina pubkey as the claim recipient**
 * — REQUIRED for the on-chain-settleable participant-form channelHash
 * (`Poseidon([client.x, apex.x, 0])`). Without it the claim is off-chain-only
 * (non-settleable), so we fail loudly rather than silently degrade.
 */
async function resolveMina(
  env: SettlementEnv,
  ctx: {
    nostrPubkey: string;
    nostrSecretKey: Uint8Array;
    evmPrivKey: string;
    mnemonic: string;
    deposit: string;
  }
): Promise<ResolvedSettlement> {
  const chainKey = env['MINA_CHAIN_KEY']?.trim() || 'mina:devnet';
  const graphqlUrl = env['MINA_GRAPHQL_URL']?.trim();
  const zkAppAddress = env['MINA_ZKAPP_ADDRESS']?.trim();
  const apexMina =
    env['APEX_MINA_PUBKEY']?.trim() ||
    env['TARGET_SETTLEMENT_ADDRESS_MINA']?.trim();
  const depositAmount = env['MINA_DEPOSIT_AMOUNT']?.trim();

  if (!graphqlUrl)
    throw new Error('SETTLEMENT_CHAIN=mina requires MINA_GRAPHQL_URL');
  if (!zkAppAddress)
    throw new Error('SETTLEMENT_CHAIN=mina requires MINA_ZKAPP_ADDRESS');
  // HARD GUARD: participant-form (on-chain-settleable) claims require the apex
  // Mina pubkey at SIGN time. Absent → the signer falls back to the legacy
  // zkApp-x form which the zkApp's claimFromChannel cannot verify. Fail loud.
  if (!apexMina) {
    throw new Error(
      'SETTLEMENT_CHAIN=mina requires the apex Mina settlement pubkey ' +
        '(APEX_MINA_PUBKEY or TARGET_SETTLEMENT_ADDRESS_MINA). It is folded into ' +
        'the participant-form channelHash Poseidon([client.x, apex.x, 0]); without ' +
        'it the claim is OFF-CHAIN-ONLY (non-settleable). Refusing to sign a ' +
        'non-settleable Mina claim.'
    );
  }
  if (!/^B62[a-zA-Z0-9]{40,60}$/.test(apexMina)) {
    throw new Error(
      `apex Mina pubkey "${apexMina}" is not a valid B62 address — cannot bind ` +
        'the participant-form Mina claim'
    );
  }

  const identity = await deriveFullIdentity(ctx.mnemonic);
  if (!identity.mina.privateKey) {
    throw new Error(
      'Mina key derivation failed (missing mina-signer) — cannot settle on Mina'
    );
  }
  // Construct WITH the apex pubkey-bound recipient flowing through signBalanceProof.
  const minaSigner = new MinaSigner(
    identity.mina.privateKey,
    identity.mina.publicKey
  );

  const evmSigner = new EvmSigner(ctx.evmPrivKey);
  const channelClient = new OnChainChannelClient({
    evmSigner,
    chainRpcUrls: {},
  });
  channelClient.setMinaConfig({
    graphqlUrl,
    zkAppAddress,
    privateKey: identity.mina.privateKey,
    ...(depositAmount && BigInt(depositAmount) > 0n
      ? { deposit: { amount: depositAmount } }
      : {}),
  });

  let channelId = '';
  const params: OpenChannelParams = {
    peerId: 'apex',
    chain: chainKey,
    token: zkAppAddress,
    // peerAddress is the apex Mina settlement B62 (participantB) for the open.
    peerAddress: apexMina,
    settlementTimeout: 86400,
  };

  return {
    chain: 'mina',
    chainKey,
    apexSettlementAddress: apexMina,
    channelClient,
    evmAddress: evmSigner.address,
    nostrPubkey: ctx.nostrPubkey,
    nostrSecretKey: ctx.nostrSecretKey,
    openChannel: async () => {
      const open = await channelClient.openChannel(params);
      channelId = open.channelId;
      return channelId;
    },
    buildClaim: async (cumulative, nonce) => {
      if (!channelId)
        throw new Error('openChannel() must run before buildClaim()');
      // Read the on-chain depositTotal so the signed commitment binds the
      // conserved balanceB = depositTotal − balanceA — the SAME value the
      // connector derives from on-chain state (connector#133). Using the same
      // public source on both sides guarantees the commitments match and
      // signatureA verifies in the on-chain claimFromChannel circuit.
      const depositTotal = await readMinaDepositTotal(graphqlUrl, zkAppAddress);
      const proof = await minaSigner.signBalanceProof({
        channelId,
        nonce,
        transferredAmount: cumulative,
        lockedAmount: 0n,
        locksRoot: ZERO_LOCKS_ROOT,
        // recipient = apex Mina pubkey → participant-form (on-chain-settleable).
        recipient: apexMina,
        metadata: { chainType: 'mina', zkAppAddress },
        depositTotal,
      });
      return minaSigner.buildClaimMessage(proof, ctx.nostrPubkey);
    },
  };
}

export interface ResolveSettlementInput {
  env: SettlementEnv;
  /** Sender Nostr pubkey (hex). */
  nostrPubkey: string;
  /** Sender Nostr secret key. */
  nostrSecretKey: Uint8Array;
  /** EVM funding private key (0x…). Used for the EVM signer + as the channel-open gas key. */
  evmPrivKey: string;
  /**
   * BIP-39 mnemonic. REQUIRED for solana/mina (per-chain key derivation). If
   * omitted in a non-EVM run, resolveSettlement throws. A throwaway mnemonic is
   * generated when absent only for the EVM path (which never uses it).
   */
  mnemonic?: string;
  /** EVM-only knobs (defaults supplied by the harness constants). */
  anvilRpc: string;
  mockUsdc: string;
  tokenNetwork: string;
  apexEvm: string;
  /** Channel deposit (base units, string). Shared default for all chains. */
  deposit: string;
}

/**
 * Resolve the selected settlement chain (`SETTLEMENT_CHAIN`, default `evm`).
 * Dispatches to the per-chain resolver and returns a uniform handle.
 */
export async function resolveSettlement(
  input: ResolveSettlementInput
): Promise<ResolvedSettlement> {
  const chain = (
    input.env['SETTLEMENT_CHAIN']?.trim() || 'evm'
  ).toLowerCase() as SettlementChain;

  if (chain === 'evm') {
    return resolveEvm(input.env, {
      nostrPubkey: input.nostrPubkey,
      nostrSecretKey: input.nostrSecretKey,
      evmPrivKey: input.evmPrivKey,
      anvilRpc: input.anvilRpc,
      mockUsdc: input.mockUsdc,
      tokenNetwork: input.tokenNetwork,
      apexEvm: input.apexEvm,
      deposit: input.deposit,
    });
  }

  const mnemonic = input.mnemonic;
  if (!mnemonic) {
    throw new Error(
      `SETTLEMENT_CHAIN=${chain} requires a mnemonic for per-chain key derivation ` +
        '(set MNEMONIC in env/handoff)'
    );
  }

  if (chain === 'solana') {
    return resolveSolana(input.env, {
      nostrPubkey: input.nostrPubkey,
      nostrSecretKey: input.nostrSecretKey,
      evmPrivKey: input.evmPrivKey,
      mnemonic,
      deposit: input.deposit,
    });
  }
  if (chain === 'mina') {
    return resolveMina(input.env, {
      nostrPubkey: input.nostrPubkey,
      nostrSecretKey: input.nostrSecretKey,
      evmPrivKey: input.evmPrivKey,
      mnemonic,
      deposit: input.deposit,
    });
  }

  throw new Error(
    `Unknown SETTLEMENT_CHAIN="${chain}" (expected one of evm|solana|mina)`
  );
}

// ─────────────────────────── BTP transport ──────────────────────────────────

export interface ResolvedBtpTransport {
  /** The BTP URL to dial. */
  btpUrl: string;
  /**
   * `createWebSocket` for the SOCKS5 path; `undefined` for DIRECT (native WS).
   * Pass straight into `BtpRuntimeClient` — when undefined the client uses its
   * built-in native WebSocket.
   */
  createWebSocket?: (url: string) => WebSocket;
  /** 'direct' (plain ws://) or 'socks' (existing SocksProxyAgent path). */
  mode: 'direct' | 'socks';
  /** Human-readable description for logging. */
  describe: string;
}

export interface ResolveBtpTransportInput {
  env: SettlementEnv;
  /** SOCKS proxy URL (used only in the SOCKS path). */
  socksProxy: string;
  /** BTP URL for the SOCKS path (ws://<host>:3000/btp). */
  socksBtpUrl: string;
  /** WS handshake timeout (ms). */
  handshakeTimeoutMs: number;
}

/**
 * Pick the BTP transport. DIRECT (plain `ws://`, native WS, no proxy) when
 * `DIRECT_BTP=1` or `APEX_BTP_URL` is set; otherwise the existing SOCKS5 path,
 * preserved byte-for-byte.
 */
export function resolveBtpTransport(
  input: ResolveBtpTransportInput
): ResolvedBtpTransport {
  const directFlag = input.env['DIRECT_BTP']?.trim();
  const apexBtpUrl = input.env['APEX_BTP_URL']?.trim();
  const wantDirect =
    apexBtpUrl !== undefined ||
    directFlag === '1' ||
    directFlag?.toLowerCase() === 'true';

  if (wantDirect) {
    const btpUrl = apexBtpUrl || input.socksBtpUrl;
    // DIRECT: omit createWebSocket → BtpRuntimeClient uses its native WS. No SOCKS.
    return {
      btpUrl,
      mode: 'direct',
      describe: `direct ws:// ${btpUrl} (no SOCKS)`,
    };
  }

  // SOCKS path — unchanged from the legacy harnesses (ws over a SocksProxyAgent;
  // the `ws` instance is cast to the DOM WebSocket shape BtpRuntimeClient expects).
  const wsAgent = new SocksProxyAgent(input.socksProxy);
  const createWebSocket = (url: string): WebSocket =>
    new WsWebSocket(url, {
      agent: wsAgent,
      handshakeTimeout: input.handshakeTimeoutMs,
    }) as unknown as WebSocket;
  return {
    btpUrl: input.socksBtpUrl,
    createWebSocket,
    mode: 'socks',
    describe: `SOCKS ${input.socksProxy} → ${input.socksBtpUrl}`,
  };
}

// ─────────────────────────── Relay transport ────────────────────────────────

export interface ResolvedRelayTransport {
  /** The Nostr-relay WS URL to dial (plain ws://host:7100 for direct, .anyone HS for SOCKS). */
  relayUrl: string;
  /**
   * Factory that opens a `ws` socket to the relay. DIRECT → a plain native
   * socket (no agent). SOCKS → a socket bound to a `SocksProxyAgent` reaching
   * the relay hidden service. Harnesses call this for BOTH the publish-WS (3a)
   * and the subscribe (3b) so the two share one direct-or-SOCKS decision.
   */
  createWebSocket: (url: string, timeoutMs: number) => WsWebSocket;
  /** 'direct' (plain ws://) or 'socks' (SocksProxyAgent → relay HS). */
  mode: 'direct' | 'socks';
  /** Human-readable description for logging. */
  describe: string;
}

export interface ResolveRelayTransportInput {
  env: SettlementEnv;
  /**
   * The relay `.anyone`/`.anon` hidden-service ws URL used by the SOCKS path
   * (legacy default endpoint). Only dialed when SOCKS is selected.
   */
  socksRelayUrl: string;
  /**
   * SOCKS proxy URL for the relay HS path. Falls back to the env `SOCKS_PROXY`
   * when `RELAY_SOCKS_PROXY` is unset.
   */
  socksProxy: string;
}

/**
 * Pick the relay READ/SUBSCRIBE transport. Reads are free, so DIRECT is the
 * DEFAULT: dial a plain `ws://<relay-host>:7100` (from `RELAY_WS_URL`, default
 * `ws://127.0.0.1:7100`) with a native `ws` socket — no SOCKS agent.
 *
 * SOCKS/ATOR is OPT-IN: set `RELAY_SOCKS_PROXY` (or, for backward compatibility,
 * the existing `SOCKS_PROXY` plus a `.anyone`/`.anon` relay URL via
 * `RELAY_WS_URL`) to route to the relay hidden service through a SocksProxyAgent
 * — the legacy harness behaviour, preserved byte-for-byte.
 */
export function resolveRelayTransport(
  input: ResolveRelayTransportInput
): ResolvedRelayTransport {
  const relayWsUrl = input.env['RELAY_WS_URL']?.trim();
  const relaySocksProxy = input.env['RELAY_SOCKS_PROXY']?.trim();

  // SOCKS is opt-in. Two ways to ask for it:
  //   - RELAY_SOCKS_PROXY explicitly set, OR
  //   - RELAY_WS_URL points at a hidden service (.anyone / .anon) — that can
  //     only be reached through the proxy, so honour the legacy SOCKS_PROXY.
  const urlIsHiddenService =
    relayWsUrl !== undefined && /\.(anyone|anon)(:|\/|$)/.test(relayWsUrl);
  const wantSocks = relaySocksProxy !== undefined || urlIsHiddenService;

  if (wantSocks) {
    const proxy = relaySocksProxy || input.socksProxy;
    const relayUrl = relayWsUrl || input.socksRelayUrl;
    const createWebSocket = (url: string, timeoutMs: number): WsWebSocket => {
      const agent = new SocksProxyAgent(proxy);
      return new WsWebSocket(url, { agent, handshakeTimeout: timeoutMs });
    };
    return {
      relayUrl,
      createWebSocket,
      mode: 'socks',
      describe: `SOCKS ${proxy} → ${relayUrl}`,
    };
  }

  // DIRECT (default): plain ws://, native socket, no SOCKS agent. Reads are free.
  const relayUrl = relayWsUrl || 'ws://127.0.0.1:7100';
  const createWebSocket = (url: string, timeoutMs: number): WsWebSocket =>
    new WsWebSocket(url, { handshakeTimeout: timeoutMs });
  return {
    relayUrl,
    createWebSocket,
    mode: 'direct',
    describe: `direct ws:// ${relayUrl} (no SOCKS)`,
  };
}

/** Re-export so harnesses can generate a throwaway mnemonic if needed. */
export { generateMnemonic };
