/**
 * `socks5h://` URL parsing, kept apart from the transport that uses it.
 *
 * Config validation has to reject a bad proxy URL, and config validation runs
 * everywhere — including in a browser, where `./socks.js` must never be loaded
 * (it reaches for `node:module` on the first line). This module is pure.
 */

/**
 * Parses and validates a `socks5h://` URL.
 *
 * Enforces the `socks5h://` scheme, not `socks5://`: the trailing `h` means the
 * *proxy* resolves the hostname. Under plain `socks5://` the client resolves it
 * locally first, which for a `.anyone` address means shipping the hidden service
 * you are about to talk to into a plaintext DNS query — the exact fact the
 * hidden service exists to withhold. Mirrors the connector's `transport/socks-url.ts`.
 */
export function validateSocks5hUrl(socksProxy: string): { host: string; port: number } {
  if (typeof socksProxy !== 'string' || !socksProxy.startsWith('socks5h://')) {
    const got = typeof socksProxy === 'string' ? socksProxy.split('://')[0] + '://' : typeof socksProxy;
    throw new Error(
      `SOCKS5 proxy URL must use the socks5h:// scheme (got ${JSON.stringify(got)}). ` +
        'The "h" makes the proxy resolve the hostname, so a .anyone address never ' +
        'leaks into a local DNS query.'
    );
  }

  // Parse by swapping in a scheme `URL` understands; `socks5h:` is not special-cased.
  let parsed: URL;
  try {
    parsed = new URL(socksProxy.replace(/^socks5h:\/\//, 'http://'));
  } catch {
    throw new Error(`Malformed SOCKS5 proxy URL: ${JSON.stringify(socksProxy)}`);
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 1080;

  if (!host) throw new Error(`SOCKS5 proxy URL missing host: ${JSON.stringify(socksProxy)}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SOCKS5 proxy port out of range (1–65535): ${parsed.port}`);
  }

  return { host, port };
}
