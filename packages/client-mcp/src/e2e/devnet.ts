/**
 * Deployed-devnet wiring for the e2e/journey suites.
 *
 * This module centralizes the DEPLOYED devnet endpoints and a faucet-funding
 * step so a live e2e run can:
 *   1. derive the daemon/client EVM address from its mnemonic,
 *   2. drip test ETH + USDC to it from the devnet faucet (via the client SDK's
 *      {@link fundWallet} helper), then
 *   3. publish paid writes that route through the connector PROXY's `POST /ilp`
 *      (ILP-over-HTTP) — NO BTP socket required.
 *
 * GATING: everything here is OPT-IN. A live run is enabled only when
 * `TOON_DEVNET_E2E=1` is set (it needs network access to the deployed Linode
 * node + treasury-funded faucet). The normal unit suite never touches the
 * network — `isDevnetE2eEnabled()` returns false by default.
 *
 * The eventual home for these endpoint constants is a `@toon-protocol/core`
 * devnet preset; until that npm release ships they live here as explicit config.
 */

import {
  EvmSigner,
  fundWallet,
  deriveNostrKeyFromMnemonic,
  type FaucetChain,
} from '@toon-protocol/client';

/** Canonical deployed-devnet endpoints (see toon-meta docs/deployment.md). */
export const DEVNET = {
  /** Nostr WS relay — FREE reads, OFF the pay path. */
  relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
  /** Connector payment-proxy base — paid writes via `POST /ilp`. */
  proxyUrl: 'https://proxy.devnet.toonprotocol.dev',
  /** Faucet base — `POST /api/request` (EVM), `/api/solana/request`, `/api/mina/request`. */
  faucetUrl: 'https://faucet.devnet.toonprotocol.dev',
  /** Apex ILP destination on the deployed edge. */
  destination: 'g.proxy',
  /** EVM (Anvil) chain id. */
  evmChainId: 31337,
  /** EVM RPC. */
  evmRpcUrl: 'https://evm-rpc.devnet.toonprotocol.dev',
  /** Mock USDC (6 decimals). */
  mockUsdc: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  usdcDecimals: 6,
} as const;

/**
 * Daemon env for a devnet run. Spread into the e2e harness `extraEnv`. The
 * daemon resolves these into a `ToonClientConfig` with `proxyUrl` set, so paid
 * writes route through the connector proxy over ILP-over-HTTP (no BTP socket).
 *
 * NOTE: `TOON_CLIENT_MNEMONIC` is supplied separately by the harness (it owns
 * the identity); pass it through here only if you are not using the harness.
 */
export function devnetDaemonEnv(): Record<string, string> {
  return {
    TOON_CLIENT_NETWORK: 'devnet',
    TOON_CLIENT_PROXY_URL: DEVNET.proxyUrl,
    TOON_CLIENT_FAUCET_URL: DEVNET.faucetUrl,
    TOON_CLIENT_RELAY_URL: DEVNET.relayUrl,
    TOON_CLIENT_DESTINATION: DEVNET.destination,
  };
}

/** Whether a LIVE devnet e2e run is enabled (opt-in; needs network + funds). */
export function isDevnetE2eEnabled(): boolean {
  return process.env['TOON_DEVNET_E2E'] === '1';
}

/** Derive the 0x EVM address for a daemon/client mnemonic (BIP-44 account 0). */
export function evmAddressForMnemonic(
  mnemonic: string,
  accountIndex = 0
): string {
  // Nostr + EVM share the secp256k1 key; EvmSigner accepts the raw 32 bytes.
  const { secretKey } = deriveNostrKeyFromMnemonic(mnemonic, accountIndex);
  return new EvmSigner(secretKey).address;
}

/**
 * Fund the client wallet from the devnet faucet BEFORE publishing.
 *
 * EVM is implemented (drips 100 ETH + 10k USDC). Solana/Mina are deferred (WS3)
 * and {@link fundWallet} throws a clear error for them.
 *
 * @param mnemonic - The daemon/client identity mnemonic.
 * @param chain - Faucet chain (default `evm`).
 * @throws when the live e2e gate is OFF (`TOON_DEVNET_E2E` !== '1'), to prevent
 *   accidental network calls from the normal suite.
 */
export async function fundDevnetWallet(
  mnemonic: string,
  chain: FaucetChain = 'evm'
): Promise<{ address: string; response: unknown }> {
  if (!isDevnetE2eEnabled()) {
    throw new Error(
      'fundDevnetWallet: live devnet e2e is disabled. Set TOON_DEVNET_E2E=1 ' +
        '(requires network access + a treasury-funded faucet).'
    );
  }
  // Solana/Mina addresses derive differently; only EVM is wired here (WS3).
  if (chain !== 'evm') {
    throw new Error(`fundDevnetWallet: ${chain} funding is deferred (WS3)`);
  }
  const address = evmAddressForMnemonic(mnemonic);
  const { response } = await fundWallet(DEVNET.faucetUrl, address, chain);
  return { address, response };
}
