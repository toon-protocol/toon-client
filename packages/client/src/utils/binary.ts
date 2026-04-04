/**
 * Isomorphic binary helpers — works in both Node.js and browser
 * without requiring Buffer polyfills.
 *
 * These replace Buffer usage throughout the client package so that
 * browser consumers (e.g. ditto) don't need the `buffer` npm polyfill.
 */

/** Convert a Uint8Array to a base64 string (browser + Node compatible). */
export function toBase64(bytes: Uint8Array): string {
  // Node.js Buffer is a Uint8Array subclass and has toString('base64')
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
    return (bytes as Buffer).toString('base64');
  }
  // Browser path: use btoa with binary string
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert a base64 string to a Uint8Array (browser + Node compatible). */
export function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Convert a Uint8Array to a hex string. */
export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** Convert a hex string to a Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Convert a UTF-8 string to Uint8Array. */
export function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert a Uint8Array to a UTF-8 string. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Check if a string is valid base64. */
export function isBase64(str: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

