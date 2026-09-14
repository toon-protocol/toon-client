/**
 * `@toon-protocol/client/hidden-service` — the Node-only entry point.
 *
 * Separate from the library barrel because everything here loads `node:module`,
 * `node:net` and friends: a browser cannot dial a `.anyone` address by any
 * route, so a browser bundle must never follow an import into this file.
 */
export {
  DEFAULT_HS_CONNECT_TIMEOUT_MS,
  createHiddenServiceTransport,
  probeSocks5Proxy,
} from './socks.js';
export { validateSocks5hUrl } from './socks-url.js';
export type { HiddenServiceTransport, HiddenServiceTransportOptions } from './socks.js';
