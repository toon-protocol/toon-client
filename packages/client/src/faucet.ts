/**
 * Devnet faucet helper.
 *
 * The deployed TOON devnet exposes a faucet that drips test funds to a given
 * chain address so a client can open payment channels and pay for writes:
 *
 *   EVM     `POST {faucetUrl}/api/request`        body `{ address }` → 100 ETH + 10k USDC
 *   Solana  `POST {faucetUrl}/api/solana/request` body `{ address }` → SOL + USDC
 *   Mina    `POST {faucetUrl}/api/mina/request`   body `{ address }` → native MINA only
 *
 * Devnet edge (today): `https://faucet.devnet.toonprotocol.dev`.
 *
 * EVM is implemented fully. Solana/Mina are deferred to a later milestone (WS3)
 * and throw a clear error so callers don't silently assume funding happened.
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
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
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
 * @param chain - `'evm'` (implemented) | `'solana'` | `'mina'` (deferred — throw).
 * @throws {Error} If `faucetUrl`/`address` is missing, or the chain is deferred.
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

  // Solana/Mina faucet flows are deferred (WS3). Fail loudly rather than
  // pretend a drip happened.
  if (chain === 'solana' || chain === 'mina') {
    throw new Error(
      `fundWallet: ${chain} faucet funding is deferred (WS3) — not yet implemented`
    );
  }

  const base = faucetUrl.replace(/\/+$/, '');
  const url = `${base}${faucetPath(chain)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeout ?? 30000;

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
