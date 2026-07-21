/**
 * Devnet faucet helper.
 *
 * The deployed TOON devnet exposes a faucet that drips the settlement token
 * (USDC) to a given chain address so a client can open payment channels and pay
 * for writes. This helper hits the USDC-ONLY faucet legs — it funds USDC and
 * assumes the wallet already holds enough native gas to transact:
 *
 *   EVM     `POST {faucetUrl}/api/base-sepolia/request` body `{ address }` → USDC (Base Sepolia mint)
 *   Solana  `POST {faucetUrl}/api/solana/usdc-request`  body `{ address }` → USDC (no SOL leg)
 *   Mina    `POST {faucetUrl}/api/mina/usdc-request`    body `{ address }` → USDC (no MINA leg)
 *
 * Devnet edge (today): `https://faucet.devnet.toonprotocol.dev`.
 *
 * All three chains are live on the deployed faucet — the request shape is
 * identical (`{ address }`); only the path differs. (The EVM leg mints the
 * ungated mock USDC on Base Sepolia and best-effort tops up gas; the Solana and
 * Mina legs are strictly USDC-only and expect the address to already hold gas.)
 */

import { NetworkError } from './errors.js';

/** Supported faucet chains. */
export type FaucetChain = 'evm' | 'solana' | 'mina';

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
   * for the chain (fast 30s for evm/solana, a longer 120s for the slow-settling
   * mina faucet).
   */
  timeout?: number;
}

/**
 * Default faucet request timeout (ms) for a chain.
 *
 * The EVM (Base Sepolia mint) and Solana USDC legs respond in a few seconds, so
 * 30s is plenty. The Mina USDC leg TRANSFERS the token via an o1js-proven
 * transaction on a chain that settles much more slowly: the drip routinely
 * succeeds server-side but takes well over 30s to answer the HTTP request, so a
 * flat 30s budget makes the client give up on a request that actually worked.
 * Give mina a much longer budget.
 */
export function defaultFaucetTimeout(chain: FaucetChain): number {
  return chain === 'mina' ? 120000 : 30000;
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
    case 'mina':
      return '/api/mina/usdc-request';
  }
}

/**
 * Drip test funds to `address` on `chain` from the devnet `faucetUrl`.
 *
 * @param faucetUrl - Faucet base URL, e.g. `https://faucet.devnet.toonprotocol.dev`.
 *   A trailing `/` is tolerated.
 * @param address - The chain address to fund (EVM 0x address, Solana base58, etc).
 * @param chain - `'evm'` | `'solana'` | `'mina'` (all live on the devnet faucet).
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
