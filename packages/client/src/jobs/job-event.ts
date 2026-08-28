/**
 * The signed job event a NIP-90 app behind a connector reads.
 *
 * Some apps a connector fronts are not plain HTTP handlers: the store and the
 * gas station both take their input as a **kind-tagged Nostr event** whose
 * arguments are `['param', key, value]` tags, and answer in the FULFILL body.
 * There is no relay and no round trip — the event is the request body of the
 * paid POST, and the receipt comes back in that same response.
 *
 * The signature on the event is **integrity, not identity**. Both apps say so
 * in as many words: it proves the tags were not altered between this client and
 * the handler, and nothing else — who paid is the connector's `X-TOON-Payer`
 * header, proved against a claim, and no app takes an event pubkey for an
 * authority. So the key here is generated per event by default. A caller who
 * wants a stable pubkey in the app's logs can supply one; nothing about the
 * job's outcome depends on which key it is.
 *
 * This is why the 1.0 client carries no Nostr identity. There is no key to
 * derive, back up or rotate — only 32 bytes to sign one request with and then
 * forget.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { encodeUtf8, toHex } from '../utils/binary.js';

/**
 * A signed Nostr event, in the field order and JSON spelling every verifier
 * expects.
 */
export interface JobEvent {
  /** 32-byte sha256 of the serialization below, hex. */
  id: string;
  /** The signing key's x-only public half, hex. */
  pubkey: string;
  /** Unix SECONDS. */
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  /** BIP-340 signature over `id`, hex. */
  sig: string;
}

/** What one job asks for: its kind, and its `param` tags. */
export interface JobEventParams {
  /** The NIP-90 job kind — `5095` for the ArNS job, `5096` for Solana gas. */
  kind: number;
  /**
   * The job's arguments, emitted in iteration order as `['param', key, value]`.
   * An `undefined` value is omitted rather than sent as the string
   * `"undefined"`, so an optional parameter can be passed through unset.
   */
  params: Record<string, string | undefined>;
  /** Extra tags to carry beside the params. Rarely needed. */
  tags?: string[][];
  /** Default `''`. Neither of this repository's job kinds reads it. */
  content?: string;
  /** 32-byte secp256k1 secret. Default: a fresh one, used once. */
  secretKey?: Uint8Array;
  /** Unix seconds. Default `Date.now() / 1000`, floored. */
  createdAt?: number;
}

/**
 * NIP-01 serialization: a six-element array, `JSON.stringify`d exactly as
 * written. The verifier recomputes this from the event's own fields, so any
 * difference in shape — a reordered key, a number where a string belongs —
 * surfaces as an id mismatch rather than as a validation message.
 */
function serializeForId(event: Omit<JobEvent, 'id' | 'sig'>): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/**
 * Build and sign one job event.
 *
 * @returns The event, ready to be the `{ event }` body of a paid POST.
 */
export function buildJobEvent(params: JobEventParams): JobEvent {
  const secretKey = params.secretKey ?? randomBytes(32);
  const pubkey = toHex(new Uint8Array(schnorr.getPublicKey(secretKey)));

  const tags: string[][] = [];
  for (const [key, value] of Object.entries(params.params)) {
    if (value !== undefined) tags.push(['param', key, value]);
  }
  if (params.tags) tags.push(...params.tags);

  const unsigned = {
    pubkey,
    created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
    kind: params.kind,
    tags,
    content: params.content ?? '',
  };

  const idBytes = sha256(encodeUtf8(serializeForId(unsigned)));
  return {
    ...unsigned,
    id: toHex(idBytes),
    sig: toHex(new Uint8Array(schnorr.sign(idBytes, secretKey))),
  };
}

/** First value of a `['param', key, value]` tag, if the event carries one. */
export function jobEventParam(event: JobEvent, key: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 'param' && tag[1] === key) return tag[2];
  }
  return undefined;
}
