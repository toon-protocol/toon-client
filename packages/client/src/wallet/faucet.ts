/**
 * Devnet faucet helper.
 *
 * The public TOON devnet runs a faucet that drips the settlement token (USDC)
 * to an address so a client can open a payment channel and pay for requests.
 * Both legs are USDC-only: they fund the token and assume the wallet already
 * holds enough native gas to transact.
 *
 *   EVM     `POST {faucetUrl}/api/base-sepolia/request` body `{ address }`
 *   Solana  `POST {faucetUrl}/api/solana/usdc-request`  body `{ address }`
 *
 * The request shape is identical on both; only the path differs. The EVM leg
 * mints the ungated mock USDC on Base Sepolia and best-effort tops up gas; the
 * **Solana leg drips USDC and no SOL**, so a Solana wallet needs devnet SOL
 * from somewhere else (`solana airdrop`) before it can pay for a transaction.
 *
 * Devnet edge today: `https://faucet.devnet.toonprotocol.dev`. `GET /api/info`
 * on the same host reports what it is configured to drip.
 */

import { NetworkError } from '../client/errors.js';

/** Supported faucet chains. */
export type FaucetChain = 'evm' | 'solana';

/** Result of a successful faucet drip. */
export interface FundWalletResult {
  /** The chain that was funded. */
  chain: FaucetChain;
  /** The funded address (echoed back). */
  address: string;
  /** Raw parsed JSON body from the faucet (shape is faucet-defined). */
  response: unknown;
}

/** Options for {@link fundWallet}. */
export interface FundWalletOptions {
  /** Custom fetch implementation (for testing / custom transports). */
  fetchImpl?: typeof fetch;
  /**
   * Request timeout in milliseconds. Defaults to {@link defaultFaucetTimeout}
   * for the chain.
   */
  timeout?: number;
}

/**
 * Default faucet request timeout (ms) for a chain. Both legs mint or transfer
 * on a fast chain and answer in a few seconds, so 30s is ample; the parameter
 * stays per-chain so a slower leg can be given its own budget without changing
 * a caller.
 */
export function defaultFaucetTimeout(_chain: FaucetChain): number {
  return 30000;
}

/**
 * Map a chain to its USDC-only faucet request path. Each leg funds USDC and
 * assumes the address already holds native gas (the EVM leg still best-effort
 * tops up Base Sepolia ETH, but does not depend on it).
 */
function faucetPath(chain: FaucetChain): string {
  switch (chain) {
    case 'evm':
      return '/api/base-sepolia/request';
    case 'solana':
      return '/api/solana/usdc-request';
  }
}

/**
 * Drip test funds to `address` on `chain` from the devnet `faucetUrl`.
 *
 * @param faucetUrl - Faucet base URL, e.g. `https://faucet.devnet.toonprotocol.dev`.
 *   A trailing `/` is tolerated.
 * @param address - The chain address to fund (EVM `0x…`, or Solana base58).
 * @param chain - `'evm'` or `'solana'`. Both live on the devnet faucet.
 * @throws {Error} If `faucetUrl` or `address` is missing.
 * @throws {NetworkError} On transport failure or a non-2xx faucet response.
 */
export async function fundWallet(
  faucetUrl: string,
  address: string,
  chain: FaucetChain,
  options: FundWalletOptions = {}
): Promise<FundWalletResult> {
  if (!faucetUrl) {
    throw new Error('fundWallet: faucetUrl is required');
  }
  if (!address) {
    throw new Error('fundWallet: address is required');
  }

  const base = faucetUrl.replace(/\/+$/, '');
  const url = `${base}${faucetPath(chain)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeout ?? defaultFaucetTimeout(chain);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetworkError(
        `Faucet request timed out after ${timeout}ms (${url})`,
        error
      );
    }
    throw new NetworkError(
      `Faucet request failed (${url}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error : undefined
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new NetworkError(
      `Faucet responded ${response.status} ${response.statusText}${
        detail ? `: ${detail}` : ''
      } (${url})`
    );
  }

  // The faucet returns JSON; tolerate an empty/non-JSON body (some faucets
  // return `204`/plain text on success).
  const body = await response.text().catch(() => '');
  let parsed: unknown = body;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }

  return { chain, address, response: parsed };
}
