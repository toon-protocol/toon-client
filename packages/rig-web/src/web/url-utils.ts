/**
 * URL validation utilities for Rig-UI.
 *
 * Extracted from router.ts to allow the old router to be deleted
 * while relay-client.ts retains its WebSocket URL validation.
 */

/**
 * Validate that a relay URL uses the WebSocket protocol.
 *
 * @param url - URL string to validate
 * @returns true if the URL uses a WebSocket protocol scheme
 */
export function isValidRelayUrl(url: string): boolean {
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  return /^wss?:\/\//i.test(url);
}
