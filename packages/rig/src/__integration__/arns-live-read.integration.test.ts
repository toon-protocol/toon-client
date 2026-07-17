/**
 * #376 acceptance check: drive `rig name`'s default adapter against the
 * PUBLISHED `@ar.io/sdk` (the registry-resolved install, not a stub) and
 * execute real FREE reads on the live mainnet registry. Both #376 bugs — the
 * nonexistent `SolanaSigner` guard and the assumed `ARIO.init()` defaults —
 * came from coding against an API surface no released SDK exports, which
 * type checks and stub-driven tests cannot catch. Only a live import + read
 * can.
 *
 * SAFETY: read-only. No signer is ever constructed (`mode: 'read'` with
 * all-zero key bytes proves it), nothing is signed, written, or spent.
 *
 * NETWORK-GATED: hits the public Solana mainnet RPC, so it is opt-in and
 * skipped offline/in CI by default. Run it with:
 *
 *   pnpm test:arns-live          # repo root (sets ARNS_LIVE_SMOKE=1)
 */

import { describe, expect, it } from 'vitest';
import { defaultLoadArns, type ArnsSdk } from '../cli/name.js';

const LIVE = process.env['ARNS_LIVE_SMOKE'] === '1';

/** A signerless, mainnet-targeted SDK — zero key material (all-zero bytes). */
function loadReadOnlySdk(): Promise<ArnsSdk> {
  return defaultLoadArns({
    mode: 'read',
    solanaSecretKey: new Uint8Array(64),
    solanaPublicKey: 'read-only-smoke',
    network: 'mainnet',
  });
}

describe.skipIf(!LIVE)('live @ar.io/sdk free-read smoke (#376)', () => {
  it('quotes a Buy-Name cost from the live registry with no signer', async () => {
    const sdk = await loadReadOnlySdk();
    const mario = await sdk.getTokenCost({
      intent: 'Buy-Name',
      name: 'toon-protocol-rig-376-smoke',
      type: 'lease',
      years: 1,
    });
    // A live mARIO quote — the exact figure floats with the demand factor,
    // but it is always a positive integer number of mARIO.
    expect(mario).toBeGreaterThan(0n);
  });

  it('reads an existing ArNS record + its ANT targets with no signer', async () => {
    const sdk = await loadReadOnlySdk();
    // `ardrive` is the canonical long-lived ArNS name (the issue's repro).
    const record = await sdk.getArNSRecord({ name: 'ardrive' });
    expect(record?.processId).toBeTruthy();
    expect(record?.type === 'lease' || record?.type === 'permabuy').toBe(true);
    // The seam contract is ms epoch (the SDK reports cluster seconds — the
    // adapter must normalize): any real registration is post-2001 in ms.
    expect(record?.startTimestamp ?? 0).toBeGreaterThan(1_000_000_000_000);
    if (!record?.processId) throw new Error('unreachable: asserted above');

    const ant = await sdk.ant(record.processId);
    const targets = await ant.getRecords();
    expect(Object.keys(targets).length).toBeGreaterThan(0);
    for (const target of Object.values(targets)) {
      expect(typeof target.transactionId).toBe('string');
      expect(typeof target.ttlSeconds).toBe('number');
    }
  });

  it('reports an unregistered name as null (available), not an error', async () => {
    const sdk = await loadReadOnlySdk();
    const record = await sdk.getArNSRecord({
      name: 'toon-rig-definitely-unregistered-376-smoke',
    });
    expect(record).toBeNull();
  });
});
