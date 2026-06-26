/**
 * Devnet faucet helper.
 *
 * The deployed TOON devnet exposes a faucet that drips test funds to a given
 * chain address so a client can open payment channels and pay for writes:
 *
 *   EVM     `POST {faucetUrl}/api/request`        body `{ address }` → 100 ETH + 10k USDC
 *   Solana  `POST {faucetUrl}/api/solana/request` body `{ address }` → SOL + USDC
 *   Mina    `POST {faucetUrl}/api/mina/request`   body `{ address }` → native MINA + USDC
 *
 * Devnet edge (today): `https://faucet.devnet.toonprotocol.dev`.
 *
 * All three chains are live on the deployed faucet — the request shape is
 * identical (`{ address }`); only the path differs.
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
 * EVM and Solana faucets respond in a few seconds, so 30s is plenty. The Mina
 * faucet sends native MINA *and* mints USDC on a chain that settles much more
 * slowly: the drip routinely succeeds server-side (the faucet logs
 * `✅ Mina faucet request completed`) but takes well over 30s to answer the
 * HTTP request, so a flat 30s budget makes the client give up on a request that
 * actually worked. Give mina a much longer budget.
 */
export function defaultFaucetTimeout(chain: FaucetChain): number {
  return chain === 'mina' ? 120000 : 30000;
}

/** Map a chain to its faucet request path. */
function faucetPath(chain: FaucetChain): string {
  switch (chain) {
    case 'evm':
      return '/api/request';
    case 'solana':
      return '/api/solana/request';
    case 'mina':
      return '/api/mina/request';
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
