/**
 * The canary of ADR 0005: proof, before a hidden payer starts, that every path it
 * hands a proxy to honours it.
 *
 * One request goes down each path, through the very object real traffic will
 * use, to a closed loopback port. The proxy hook on that path recognises the
 * destination, counts it and refuses the dial. A path whose hook never counted
 * the canary ignored its hook — a proxy bypass — and its real traffic would have
 * dialled clearnet. Either way the canary leaves nothing on the wire.
 *
 * NODE ONLY, for the same reason `./socks.js` is: it is imported dynamically
 * beside it.
 */
import { ProxyBypassError, type ProxiedPath } from '../client/errors.js';
import { rpcTransport } from './rpc.js';
import { CANARY_HOST, CANARY_PORT, type HiddenServiceTransport } from './socks.js';

/** How long a canary may take. A refused or bypassed dial answers at once. */
const CANARY_TIMEOUT_MS = 5_000;

const CANARY_HTTP_URL = `http://${CANARY_HOST}:${CANARY_PORT}/`;
const CANARY_WS_URL = `ws://${CANARY_HOST}:${CANARY_PORT}/`;

/**
 * Path objects to test in place of the transports' own. For tests that need a
 * deliberately broken path (a fetch that drops its dispatcher, a viem transport
 * without `fetchFn`, a websocket without its agent). Never set in production.
 *
 * @internal
 */
export interface CanaryPathOverrides {
  clientEdgeFetch?: typeof fetch;
  evmRpcTransport?: typeof rpcTransport;
  solanaRpcFetch?: typeof fetch;
  createWebSocket?: (url: string) => unknown;
}

export interface CanaryTargets {
  edge: HiddenServiceTransport;
  /** Absent when `proxyRpc` is `false`: no RPC canary runs. */
  rpc?: { evm: HiddenServiceTransport; solana: HiddenServiceTransport };
  overrides?: CanaryPathOverrides;
}

/**
 * Sends the canaries, in order, and throws {@link ProxyBypassError} for the first
 * path whose proxy hook did not see its canary.
 */
export async function proveProxy(targets: CanaryTargets): Promise<void> {
  const { edge, rpc, overrides = {} } = targets;

  await check('client-edge', edge, async () => {
    await (overrides.clientEdgeFetch ?? edge.fetch)(CANARY_HTTP_URL, {
      signal: AbortSignal.timeout(CANARY_TIMEOUT_MS),
    });
  });

  if (rpc !== undefined) {
    await check('evm-rpc', rpc.evm, async () => {
      const build = overrides.evmRpcTransport ?? rpcTransport;
      const transport = build({ url: CANARY_HTTP_URL, fetch: rpc.evm.fetch, proxied: true }, {
        timeout: CANARY_TIMEOUT_MS,
        retryCount: 0,
      })({});
      await transport.request({ method: 'eth_chainId' });
    });
    await check('solana-rpc', rpc.solana, async () => {
      await (overrides.solanaRpcFetch ?? rpc.solana.fetch)(CANARY_HTTP_URL, {
        signal: AbortSignal.timeout(CANARY_TIMEOUT_MS),
      });
    });
  }

  await check('btp', edge, () => dialWebSocket((overrides.createWebSocket ?? edge.createWebSocket)(CANARY_WS_URL)));
}

/** Runs one canary and compares the hook's count before and after. */
async function check(
  path: ProxiedPath,
  transport: HiddenServiceTransport,
  send: () => Promise<void>
): Promise<void> {
  const before = transport.canaryHits();
  try {
    await send();
  } catch {
    // A refused canary rejects; so does a bypassed one that found a closed port.
    // Only the hook's count tells them apart.
  }
  if (transport.canaryHits() === before) throw new ProxyBypassError(path);
}

/** Resolves when the socket has failed, closed or opened; then tears it down. */
function dialWebSocket(socket: unknown): Promise<void> {
  const ws = socket as {
    once(event: string, listener: () => void): void;
    on(event: string, listener: () => void): void;
    terminate?(): void;
    close(): void;
  };
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, CANARY_TIMEOUT_MS);
    function done(): void {
      clearTimeout(timer);
      try {
        (ws.terminate ?? ws.close).call(ws);
      } catch {
        // Already closed.
      }
      resolve();
    }
    ws.on('error', done);
    ws.once('close', done);
    ws.once('open', done);
  });
}
