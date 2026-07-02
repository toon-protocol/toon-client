/**
 * Minimal bech32 npub encoding for Nostr pubkeys.
 *
 * Implements bech32 encoding (BIP-173 / NIP-19) without external dependencies.
 * Only supports encoding hex pubkeys to npub format — no decoding needed for Rig-UI.
 */

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      chk ^= (b >> i) & 1 ? (GEN[i] as number) : 0;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) >> 5);
  }
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) & 31);
  }
  return ret;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) {
    ret.push((polymod >> (5 * (5 - i))) & 31);
  }
  return ret;
}

function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean
): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  }
  return ret;
}

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Encode a hex pubkey as an npub bech32 string.
 *
 * @param hexPubkey - 64-character hex string
 * @returns bech32-encoded npub string (e.g., "npub1abc...xyz")
 */
export function hexToNpub(hexPubkey: string): string {
  const hrp = 'npub';
  const bytes = hexToBytes(hexPubkey);
  const words = convertBits(bytes, 8, 5, true);
  const checksum = bech32CreateChecksum(hrp, words);
  const combined = words.concat(checksum);
  return hrp + '1' + combined.map((d) => BECH32_CHARSET[d]).join('');
}

/**
 * Decode an npub bech32 string back to a 64-character hex pubkey.
 *
 * @param npub - bech32-encoded npub string (e.g., "npub1abc...xyz")
 * @returns 64-character hex string
 * @throws if the input is not a valid npub
 */
export function npubToHex(npub: string): string {
  const lower = npub.toLowerCase();
  if (lower !== npub && npub.toUpperCase() !== npub) {
    throw new Error('npub: mixed case');
  }
  if (!lower.startsWith('npub1')) {
    throw new Error('npub: invalid prefix');
  }
  if (lower.length !== 63) {
    throw new Error('npub: invalid length');
  }

  const data: number[] = [];
  for (let i = 5; i < lower.length; i++) {
    const idx = BECH32_CHARSET.indexOf(lower[i] as string);
    if (idx === -1) throw new Error('npub: invalid character');
    data.push(idx);
  }

  // Verify checksum
  const hrpExpanded = bech32HrpExpand('npub');
  if (bech32Polymod(hrpExpanded.concat(data)) !== 1) {
    throw new Error('npub: invalid checksum');
  }

  // Strip 6-byte checksum, convert 5-bit words back to 8-bit bytes
  const words = data.slice(0, -6);
  const bytes = convertBits(words, 5, 8, false);

  // Validate: must produce exactly 32 bytes
  if (bytes.length !== 32) {
    throw new Error('npub: invalid data length');
  }

  // Validate trailing bits are zero
  const totalBits = words.length * 5;
  const trailingBits = totalBits - bytes.length * 8;
  if (trailingBits > 0) {
    const lastWord = words[words.length - 1] as number;
    const mask = (1 << trailingBits) - 1;
    if ((lastWord & mask) !== 0) {
      throw new Error('npub: non-zero padding bits');
    }
  }

  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Truncate an npub for display: first 8 + last 4 characters after the "npub1" prefix.
 *
 * @param hexPubkey - 64-character hex pubkey
 * @returns Truncated npub string like "npub1abcd1234...wxyz"
 */
export function truncateNpubFromHex(hexPubkey: string): string {
  const npub = hexToNpub(hexPubkey);
  const body = npub.slice(5); // Remove "npub1" prefix
  return `npub1${body.slice(0, 8)}...${body.slice(-4)}`;
}
