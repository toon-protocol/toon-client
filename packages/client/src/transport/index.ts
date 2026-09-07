/**
 * The browser-safe half of the hidden-service transport.
 *
 * Everything exported here is pure: hidden-service address validation and
 * `socks5h://` URL parsing, with no Node built-in anywhere behind them. That is
 * what lets config validation — which runs in a browser bundle too — refuse a
 * misconfigured hidden-service connector before a single byte or DNS query
 * leaves the process.
 *
 * The SOCKS transport that consumes these is Node-only, so only its *types*
 * appear here: exporting `createHiddenServiceTransport` itself would drag a Node
 * built-in into every browser bundle of this package. It ships as its own entry
 * point instead:
 *
 * ```ts
 * import { createHiddenServiceTransport } from '@toon-protocol/client/hidden-service';
 * ```
 */
export {
  HS_HOSTNAME_REGEX,
  HS_HOSTNAME_MAX_LENGTH,
  isRoutableHsHostname,
  isHiddenServiceUrl,
  assertRoutableHsHostname,
} from './hs-hostname.js';
export { validateSocks5hUrl } from './socks-url.js';
export type { HiddenServiceTransport, HiddenServiceTransportOptions } from './socks.js';
