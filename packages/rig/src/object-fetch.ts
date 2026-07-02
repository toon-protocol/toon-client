/**
 * The Git-from-TOON READ pipeline core (#278): download git object bodies
 * from Arweave gateways, verify them against their SHA-1, and walk the
 * object graph to prove a ref closure is complete.
 *
 * This is the CLI counterpart of rig-web's proven browser read path
 * (`web/arweave-client.ts` + `web/git-objects.ts` + the commit walker) — the
 * logic is mirrored, not imported, because the SPA package is not a library.
 *
 * Everything here is FREE (reads only: Arweave gateway GETs + the GraphQL
 * Git-SHA resolver) and pure of git — materializing objects into a real
 * repository lives in ./materialize.ts.
 *
 * INTEGRITY IS NON-NEGOTIABLE: an Arweave upload stores the object BODY
 * (content after the envelope NUL). Re-wrapping the body as each of the four
 * git object types and comparing the envelope SHA-1 against the expected SHA
 * both AUTHENTICATES the bytes and DISCOVERS the object's type in one step —
 * a body that matches under no type is rejected as corrupt/tampered, never
 * written.
 */

import {
  ARWEAVE_FETCH_TIMEOUT_MS,
  ARWEAVE_GATEWAYS,
  isValidArweaveTxId,
} from '@toon-protocol/arweave';
import { hashGitObject, type GitObjectType } from './objects.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A downloaded git object: SHA-verified body + the type that verified it. */
export interface FetchedObject {
  /** Full 40-hex SHA-1 (verified against the body). */
  sha: string;
  type: GitObjectType;
  /** Raw object body (content only, no envelope header). May be binary. */
  body: Buffer;
}

/** WHATWG-fetch seam (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface GatewayFetchOptions {
  /** Ordered gateway base URLs (default: the shared preference list). */
  gateways?: readonly string[];
  /** fetch implementation (default: global fetch). */
  fetchFn?: FetchLike;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface DownloadOptions extends GatewayFetchOptions {
  /** Maximum concurrent gateway downloads (default {@link DEFAULT_CONCURRENCY}). */
  concurrency?: number;
  /** Progress callback, called once per finished object. */
  onObject?: (done: number, total: number) => void;
}

/** Result of {@link downloadGitObjects}. */
export interface DownloadResult {
  /** SHA → verified object, for every SHA that could be downloaded. */
  objects: Map<string, FetchedObject>;
  /** SHAs whose txId 404'd/errored on EVERY gateway (propagation lag). */
  unavailable: { sha: string; txId: string }[];
}

/** Default parallel-download cap. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * A downloaded body did not hash to its expected SHA under ANY git object
 * type — corrupt or tampered content. The clone/fetch pipelines treat this
 * as a hard failure: nothing is written.
 */
export class ObjectIntegrityError extends Error {
  constructor(
    /** The objects that failed verification. */
    public readonly objects: { sha: string; txId: string }[]
  ) {
    super(
      `${objects.length} downloaded object(s) failed SHA-1 verification — ` +
        'the gateway content does not match the announced git SHA(s): ' +
        objects.map((o) => `${o.sha} (tx ${o.txId})`).join(', ') +
        '. Refusing to write corrupt/tampered objects.'
    );
    this.name = 'ObjectIntegrityError';
  }
}

// ---------------------------------------------------------------------------
// Verification (SHA check == type discovery)
// ---------------------------------------------------------------------------

const OBJECT_TYPES: readonly GitObjectType[] = [
  'blob',
  'tree',
  'commit',
  'tag',
];

/**
 * Verify a downloaded body against its expected SHA-1 by trying the four git
 * envelope types. Returns the verified object, or null when no type matches
 * (corrupt/tampered bytes).
 */
export function verifyObjectBody(
  expectedSha: string,
  bytes: Uint8Array
): FetchedObject | null {
  const body = Buffer.from(bytes);
  for (const type of OBJECT_TYPES) {
    if (hashGitObject(type, body).sha === expectedSha) {
      return { sha: expectedSha, type, body };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gateway download (fallback chain, mirrors rig-web's fetchArweaveObject)
// ---------------------------------------------------------------------------

/**
 * Fetch raw bytes for an Arweave tx id, trying each gateway in preference
 * order. Returns null when every gateway fails (404 / error / timeout).
 */
export async function fetchTxBytes(
  txId: string,
  options: GatewayFetchOptions = {}
): Promise<Uint8Array | null> {
  if (!isValidArweaveTxId(txId)) return null;
  const gateways = options.gateways ?? ARWEAVE_GATEWAYS;
  const fetchFn = options.fetchFn ?? (fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? ARWEAVE_FETCH_TIMEOUT_MS;

  for (const gateway of gateways) {
    try {
      const response = await fetchFn(`${gateway}/${txId}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      // Network error, timeout, or other failure — try the next gateway.
    }
  }
  return null;
}

/**
 * Download + verify a batch of git objects (sha → Arweave txId) with a
 * concurrency cap and per-gateway fallback.
 *
 * Objects that 404 on every gateway are reported in `unavailable` (Arweave
 * propagation lag — the caller decides whether that is fatal). Objects whose
 * bytes fail SHA-1 verification throw {@link ObjectIntegrityError}: corrupt
 * content is NEVER returned.
 */
export async function downloadGitObjects(
  entries: Iterable<[sha: string, txId: string]>,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  const queue = [...entries];
  const total = queue.length;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const objects = new Map<string, FetchedObject>();
  const unavailable: { sha: string; txId: string }[] = [];
  const corrupt: { sha: string; txId: string }[] = [];
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [sha, txId] = next;
      const bytes = await fetchTxBytes(txId, options);
      if (bytes === null) {
        unavailable.push({ sha, txId });
      } else {
        const verified = verifyObjectBody(sha, bytes);
        if (verified === null) {
          corrupt.push({ sha, txId });
        } else {
          objects.set(sha, verified);
        }
      }
      done += 1;
      options.onObject?.(done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker())
  );

  if (corrupt.length > 0) throw new ObjectIntegrityError(corrupt);
  return { objects, unavailable };
}

// ---------------------------------------------------------------------------
// Object-graph references (mirrors rig-web's git-objects parsing)
// ---------------------------------------------------------------------------

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Submodule (gitlink) tree-entry mode: references a commit in ANOTHER repo. */
const GITLINK_MODE = '160000';

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * SHAs an object references inside the SAME repository:
 *   - commit → its tree + parents
 *   - tree   → entry SHAs, EXCEPT gitlinks (mode 160000: submodule commits
 *              live in another repository and are never present — git fsck
 *              skips them too)
 *   - tag    → the tagged object
 *   - blob   → nothing
 */
export function referencedShas(object: FetchedObject): string[] {
  switch (object.type) {
    case 'blob':
      return [];
    case 'tree': {
      const refs: string[] = [];
      const data = object.body;
      let offset = 0;
      while (offset < data.length) {
        const spaceIdx = data.indexOf(0x20, offset);
        if (spaceIdx === -1) break;
        const mode = data.subarray(offset, spaceIdx).toString('utf-8');
        const nulIdx = data.indexOf(0x00, spaceIdx + 1);
        if (nulIdx === -1 || nulIdx + 21 > data.length) break;
        const sha = bytesToHex(data.subarray(nulIdx + 1, nulIdx + 21));
        if (mode !== GITLINK_MODE) refs.push(sha);
        offset = nulIdx + 21;
      }
      return refs;
    }
    case 'commit': {
      const refs: string[] = [];
      const text = object.body.toString('utf-8');
      const headerEnd = text.indexOf('\n\n');
      const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
      for (const line of header.split('\n')) {
        if (line.startsWith('tree ')) refs.push(line.slice(5).trim());
        else if (line.startsWith('parent ')) refs.push(line.slice(7).trim());
      }
      return refs.filter((sha) => FULL_SHA_RE.test(sha));
    }
    case 'tag': {
      const text = object.body.toString('utf-8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      return match?.[1] ? [match[1]] : [];
    }
  }
}

/** Result of {@link walkClosure}. */
export interface ClosureResult {
  /** Every SHA reachable from the tips that lives in `objects`. */
  reachable: Set<string>;
  /** Reachable SHAs found NEITHER in `objects` nor in `presentLocally`. */
  missing: string[];
}

/**
 * Walk the object graph from the ref tips over the downloaded object set and
 * report which reachable SHAs are missing. `presentLocally` marks SHAs that
 * already exist in the destination repository — the walk does not descend
 * into them (a consistent local repo carries its own closure; the same
 * assumption `git fetch` makes).
 */
export function walkClosure(
  tips: Iterable<string>,
  objects: ReadonlyMap<string, FetchedObject>,
  presentLocally: ReadonlySet<string> = new Set()
): ClosureResult {
  const reachable = new Set<string>();
  const missing = new Set<string>();
  const stack = [...new Set(tips)];

  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (reachable.has(sha) || missing.has(sha)) continue;
    if (presentLocally.has(sha)) continue; // local closure assumed complete
    const object = objects.get(sha);
    if (!object) {
      missing.add(sha);
      continue;
    }
    reachable.add(sha);
    for (const ref of referencedShas(object)) {
      if (!reachable.has(ref) && !missing.has(ref)) stack.push(ref);
    }
  }

  return { reachable, missing: [...missing] };
}
