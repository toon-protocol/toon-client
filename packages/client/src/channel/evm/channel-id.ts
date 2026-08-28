/**
 * Computing a `TokenNetwork` channel id from the pair it belongs to.
 *
 * This exists because of what it makes possible, which is bigger than saving a
 * call. Since
 * [ADR 0059](https://github.com/toon-protocol/connector/blob/main/docs/adr/0059-a-channel-is-derived-from-its-participants.md)
 * a channel's id is `keccak256(abi.encodePacked(p1, p2, epoch))` over the sorted
 * participant pair, so **anyone holding two addresses can compute the id and ask
 * the chain whether that channel exists** — with no event log, no reverse index
 * and no records of their own. A client that has forgotten which channel it holds
 * with a connector, or that never knew, can therefore *adopt* the open one rather
 * than opening and collateralising a second: at most one live channel exists per
 * pair, because the epoch advances only on settlement.
 *
 * That is also why the epoch is a parameter and never a guess. It is read from
 * `TokenNetwork.channelEpoch(p1, p2)`; a caller that invents one derives an id
 * nothing is at.
 *
 * Mirrors `connector/crates/connector-settlement-evm/src/channel_id.rs`, which is
 * itself a mirror of `TokenNetwork.sol`'s `openChannel`. The three must agree
 * byte for byte, so the preimage layout is asserted in this module's tests
 * against viem's own `encodePacked` rather than only implied by a round trip.
 */
import { keccak256 } from 'viem';

/** A 20-byte EVM address, `0x`-prefixed. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Put a pair into the order `TokenNetwork.openChannel` normalises them to —
 * ascending by address, `p1 < p2` — so both sides of a channel derive the same
 * id from opposite arguments.
 *
 * The comparison is over the address BYTES, which is what Solidity's `<` on an
 * `address` compares. Comparing the hex strings gives the same answer only once
 * they are lower-cased: `'0xA…' < '0xb…'` is true in ASCII while `'0xa…' <
 * '0xB…'` is false, so an EIP-55 checksummed pair sorted as text can land in the
 * wrong order and derive an id nothing is at.
 */
export function sortParticipants(a: string, b: string): [string, string] {
  const [na, nb] = [normalizeAddress(a), normalizeAddress(b)];
  return na < nb ? [na, nb] : [nb, na];
}

/**
 * `keccak256(abi.encodePacked(p1, p2, epoch))` over the sorted pair — byte for
 * byte what `TokenNetwork.openChannel` computes.
 *
 * `abi.encodePacked` of `(address, address, uint256)` is 20 + 20 + 32 bytes with
 * no padding and no length prefixes; the concatenation below is exactly that.
 * Hashing the same three fields any other way — 32-byte-padded addresses, a
 * little-endian epoch — produces a well-formed, useless id.
 *
 * @param a one participant, in either order.
 * @param b the other.
 * @param epoch the pair's own `channelEpoch(p1, p2)`, READ FROM CHAIN.
 * @returns the id as `0x` + 64 lower-case hex, the one spelling
 *   `client-edge-spec.md` §1.3 canonicalises a claim's `channelId` to.
 */
export function deriveEvmChannelId(a: string, b: string, epoch: bigint): string {
  if (epoch < 0n) {
    throw new RangeError(`channelEpoch cannot be negative; got ${epoch.toString()}`);
  }
  const [p1, p2] = sortParticipants(a, b);
  const preimage = new Uint8Array(20 + 20 + 32);
  preimage.set(addressBytes(p1), 0);
  preimage.set(addressBytes(p2), 20);
  preimage.set(uint256BigEndian(epoch), 40);
  return keccak256(preimage);
}

/** Lower-cased, `0x`-prefixed, and rejected outright if it is not an address. */
function normalizeAddress(address: string): string {
  if (!ADDRESS_SHAPE.test(address)) {
    throw new TypeError(
      `"${address}" is not an EVM address (expected 0x + 40 hex characters)`
    );
  }
  return address.toLowerCase();
}

/** The 20 raw bytes of a normalised address. */
function addressBytes(address: string): Uint8Array {
  const hex = address.slice(2);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * A `uint256` as 32 big-endian bytes — Solidity's own layout, and the layout the
 * Rust mirror writes with `U256::to_big_endian`.
 */
function uint256BigEndian(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v > 0n) {
    throw new RangeError(`channelEpoch ${value.toString()} does not fit in a uint256`);
  }
  return out;
}
