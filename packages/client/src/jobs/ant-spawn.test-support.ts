/**
 * The real thing, frozen: a `kind:5095 op=prepare` receipt as the deployed
 * store composes one.
 *
 * These bytes were NOT written by hand and are not this package's idea of what
 * a compiled transaction looks like. They came out of
 * `toon-protocol/store`'s own `buildAntSpawnTransaction`, driven by its real
 * `@ar.io/sdk` / `@ar.io/solana-contracts` / `@solana/kit` deps, for three
 * keypairs whose seeds are 32 repeated bytes so the fixture is reproducible.
 * That matters: a hand-rolled fixture would encode this client's understanding
 * of the v0 wire format into the expectation, and a misunderstanding in
 * `wire-transaction.ts` would then be copied faithfully into the test.
 *
 * The counter-check runs the other way too. `signSolanaWireTransaction` applied
 * to {@link ANT_SPAWN_DRAFT} with the mint and owner keys below is ACCEPTED by
 * `toon-protocol/gas-station`'s real `inspectGasStationTransaction` under its
 * deployed `DEFAULT_POLICY`, and the same transaction unsigned is refused
 * `missing_client_signature` — which is what the tests here assert the shape
 * of, without needing that package.
 *
 * Test-only. Nothing in `src/index.ts` reaches it, so it is not published.
 */

import type { ArnsAntPrepareReceipt } from './receipts.js';

/** 32-byte Ed25519 seeds. Each is one byte repeated 32 times. */
export const ANT_SPAWN_SEEDS = {
  mint: new Uint8Array(32).fill(1),
  owner: new Uint8Array(32).fill(2),
  feePayer: new Uint8Array(32).fill(3),
} as const;

export const ANT_SPAWN_ADDRESSES = {
  mint: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
  owner: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  feePayer: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
} as const;

/** A blockhash of the shape a gas-station quote returns. */
export const QUOTED_BLOCKHASH = 'FwRHNnp1QQrH2E4RcMPZJvBGYqCf3wjMCzYYRWEjbTWH';

/**
 * The base64 v0 wire transaction, every signature slot 64 zero bytes: 828 bytes
 * carrying ComputeBudget → System::Transfer → MPL Core CreateV1 →
 * ario_ant::initialize, over ten static accounts of which the first three sign.
 */
export const ANT_SPAWN_TRANSACTION =
    'AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAIADAAQK7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyH' +
    'N9GBOXcOqH0XX1ajVGbDTH7My42KkbTuN6Jd9g9bj8mzlIqI4910CfGV/VLbLTy6XXLKZwm/HZQS' +
    'G/N0iAG0D29ccM1psxlDGwRytEgrIunynzpyXtPrKglEdlRRiOX2GcDVX2Wi/n9LFXnERobG7HLb' +
    'Lfmo0ZYwkekVKPEkywXYV+AU67ghWM1R4EQZvCTquMlocdd1k+UM7gF/9X4Vz4gdAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAK9U' +
    'qxC9l6VCoJ73s5iJ3QzTlKTM6d+mzcl+vi0jW6dIuxTAypX4qupJUT1rJYIwAk01t4Y52WLnRzpt' +
    'goz4LGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQHAAUCgBoGAAYCAAEMAgAAAAAJ' +
    'jQAAAAAACAgCCAEACAgGCJEBAAAMAAAAdG9vbi1maXh0dXJlMAAAAGFyOi8vQW5ZdkxKVFdjRzls' +
    'cjJMbDVNd1lXWlIybzV1VEUzOVdicFlCMHpDeHdLTQEBAAAABgEAAAALAAAAQU5UIFByb2dyYW0s' +
    'AAAARGJIYlJ3VUQxb0FuMW1yRFNxdFd0dndHY05ybWhXZEQyZzhMNHhtZVE3TlgBAQkGAgQFAwEG' +
    'Va+vbR8NmJvtDAAAAHRvb24tZml4dHVyZQArAAAAQW5ZdkxKVFdjRzlscjJMbDVNd1lXWlIybzV1' +
    'VEUzOVdicFlCMHpDeHdLTQAAAAAAAAAAAAAAAAAA';

/** The whole receipt, exactly as the store answers. */
export const ANT_SPAWN_DRAFT: ArnsAntPrepareReceipt = {
  job: 'arns-buy',
  op: 'prepare',
  network: 'devnet',
  processId: ANT_SPAWN_ADDRESSES.mint,
  mint: ANT_SPAWN_ADDRESSES.mint,
  owner: ANT_SPAWN_ADDRESSES.owner,
  feePayer: ANT_SPAWN_ADDRESSES.feePayer,
  name: 'toon-fixture',
  antProgramId: 'DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX',
  transaction: ANT_SPAWN_TRANSACTION,
  recentBlockhash: '11111111111111111111111111111111',
  draft: true,
  // Compiled slot order: the fee payer, then writable signers ADDRESS-SORTED —
  // which puts the owner before the mint for these particular keys and would
  // put them the other way round for others. Nothing may read this positionally.
  requiredSigners: [
    ANT_SPAWN_ADDRESSES.feePayer,
    ANT_SPAWN_ADDRESSES.owner,
    ANT_SPAWN_ADDRESSES.mint,
  ],
  clientSigners: [ANT_SPAWN_ADDRESSES.owner, ANT_SPAWN_ADDRESSES.mint],
  rentTransferLamports: '9242880',
  estimatedFeePayerLamports: '12271560',
  instructions: ["compute-budget-limit", "system-transfer", "mpl-core-create-v1", "ario-ant-initialize"],
};

// ---------------------------------------------------------------------------
// A store and a gas station, faked at the job level
// ---------------------------------------------------------------------------

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  parseSolanaWireTransaction,
  patchSolanaRecentBlockhash,
} from '../channel/solana/wire-transaction.js';
import { base58Decode } from '../utils/base58.js';
import { toBase64, encodeUtf8, decodeUtf8 } from '../utils/binary.js';
import type { JobEvent } from './job-event.js';
import { jobEventParam } from './job-event.js';
import type { JobSender } from './send-job.js';
import type { SendRequest, SendResult } from '../client/types.js';
import type { GasStationFailureReason, GasStationReceipt } from './receipts.js';

/** An app's accepted answer: `base64(JSON)` in `data`, decoded into `result`. */
export function accepted(receipt: unknown): SendResult {
  const json = JSON.stringify(receipt);
  return answered(200, {
    accept: true,
    result: receipt,
    data: toBase64(encodeUtf8(json)),
  });
}

/** An app's rejection — it rode home on a FULFILL, and cost what work costs. */
export function rejected(code: string, message: string): SendResult {
  return answered(code === 'F00' ? 422 : 502, { accept: false, code, message });
}

/** Any HTTP answer from the app behind a route. */
export function answered(status: number, body: unknown): SendResult {
  const bytes = encodeUtf8(JSON.stringify(body));
  return {
    fulfilled: true,
    transport: 'http',
    status,
    headers: [['content-type', 'application/json']],
    body: bytes,
    text: () => decodeUtf8(bytes),
    json: <T,>() => JSON.parse(decodeUtf8(bytes)) as T,
    fulfillment: new Uint8Array(32),
  };
}

/** The packet never reached the app. */
export function refused(code: string, message: string): SendResult {
  return {
    fulfilled: false,
    transport: 'http',
    refusedBy: 'destination',
    code,
    message,
  };
}

/** One job, as the fake network saw it. */
export interface RecordedJob {
  destination: string;
  event: JobEvent;
}

/**
 * A store and a gas station on one fake connector, dispatching by destination.
 *
 * The gas station half is not a stub returning canned bytes: on `execute` it
 * runs the two checks that decide whether a real one would spend — the
 * transaction carries the blockhash IT quoted, and every slot but the fee
 * payer's holds a signature that verifies over the message. So a driver that
 * patched in the wrong order, or matched slots positionally, fails here for the
 * same reason it would fail on devnet, and with the same reason string.
 */
export class FakeJobNetwork implements JobSender {
  readonly jobs: RecordedJob[] = [];
  /** Queued overrides, consumed in order: `undefined` means "answer normally". */
  readonly answers: (SendResult | undefined)[] = [];
  quoteId = 'quote-1';

  constructor(
    readonly routes = { store: 'g.toon.store', gas: 'g.toon.gas' }
  ) {}

  /** The `param` tags of the nth job, as a plain object. */
  paramsOf(index: number): Record<string, string> {
    const job = this.jobs[index];
    if (job === undefined) throw new Error(`no job at index ${index}`);
    const out: Record<string, string> = {};
    for (const tag of job.event.tags) {
      if (tag[0] === 'param' && tag[1] !== undefined && tag[2] !== undefined) {
        out[tag[1]] = tag[2];
      }
    }
    return out;
  }

  async send(destination: string, request?: SendRequest): Promise<SendResult> {
    const event = (request?.body as { event: JobEvent }).event;
    this.jobs.push({ destination, event });

    const override = this.answers.shift();
    if (override !== undefined) return override;

    if (destination === this.routes.gas) return this.gas(event);
    if (destination === this.routes.store) return this.store(event);
    return refused('F02', `no route to ${destination}`);
  }

  private gas(event: JobEvent): SendResult {
    if (jobEventParam(event, 'phase') === 'quote') {
      return accepted({
        job: 'gas-station',
        phase: 'quote',
        status: 'ok',
        network: 'devnet',
        quoteId: this.quoteId,
        feePayer: ANT_SPAWN_ADDRESSES.feePayer,
        maxLamports: '13000000',
        recentBlockhash: QUOTED_BLOCKHASH,
        expiresAt: 1_700_000_060_000,
      } satisfies GasStationReceipt);
    }

    const wire = jobEventParam(event, 'transaction') ?? '';
    const failure = this.inspect(wire);
    if (failure !== undefined) return accepted(failure);
    return accepted({
      job: 'gas-station',
      phase: 'execute',
      status: 'ok',
      network: 'devnet',
      quoteId: jobEventParam(event, 'quoteId') ?? '',
      idempotencyKey: jobEventParam(event, 'idempotencyKey') ?? '',
      signature: '5'.repeat(87),
      slot: '312000000',
      feeLamportsActual: '12285480',
    } satisfies GasStationReceipt);
  }

  /** The subset of the real gate that can be applied without a cluster. */
  private inspect(wire: string): GasStationReceipt | undefined {
    const fail = (
      reason: GasStationFailureReason,
      detail: string
    ): GasStationReceipt => ({
      job: 'gas-station',
      phase: 'execute',
      status: 'failed',
      network: 'devnet',
      reason,
      detail,
    });

    const parsed = parseSolanaWireTransaction(wire);
    if (parsed.signers[0] !== ANT_SPAWN_ADDRESSES.feePayer) {
      return fail('fee_payer_mismatch', `fee payer is ${parsed.signers[0] ?? '(none)'}`);
    }
    if (parsed.recentBlockhash !== QUOTED_BLOCKHASH) {
      return fail(
        'blockhash_mismatch',
        `transaction blockhash ${parsed.recentBlockhash} is not the quoted ${QUOTED_BLOCKHASH}`
      );
    }
    const message = parsed.bytes.subarray(parsed.messageOffset);
    for (const [slot, signer] of parsed.signers.entries()) {
      if (signer === ANT_SPAWN_ADDRESSES.feePayer) continue;
      const start = parsed.signaturesOffset + slot * 64;
      const signature = parsed.bytes.subarray(start, start + 64);
      if (signature.every((byte) => byte === 0)) {
        return fail('missing_client_signature', `required signer ${signer} has not signed`);
      }
      if (!ed25519.verify(signature, message, base58Decode(signer))) {
        return fail(
          'simulation_failed',
          `${signer}'s signature does not verify over this message`
        );
      }
    }
    return undefined;
  }

  private store(event: JobEvent): SendResult {
    if (jobEventParam(event, 'op') === 'buy') {
      return accepted({
        job: 'arns-buy',
        network: 'devnet',
        name: jobEventParam(event, 'name') ?? '',
        type: jobEventParam(event, 'type') === 'permabuy' ? 'permabuy' : 'lease',
        years: jobEventParam(event, 'years') === undefined
          ? null
          : Number(jobEventParam(event, 'years')),
        processId: jobEventParam(event, 'processId') ?? '',
        quotedMario: '1000000',
        registryTxId: '4'.repeat(87),
        syncAttributesTxId: null,
      });
    }

    // The real store composes for whatever keys it is handed, and composes
    // deterministically: two prepares with the same params differ only in the
    // 32 blockhash bytes. Both are reproduced here — the first by substituting
    // the requested keys into the fixture's account list, the second by
    // patching, which is what lets the `reprepare` path be tested against the
    // same bytes the patch path produces.
    const owner = jobEventParam(event, 'owner') ?? ANT_SPAWN_DRAFT.owner;
    const mint = jobEventParam(event, 'mint') ?? ANT_SPAWN_DRAFT.mint;
    const quoted = jobEventParam(event, 'recentBlockhash');

    let transaction = substituteAccounts(ANT_SPAWN_TRANSACTION, {
      [ANT_SPAWN_ADDRESSES.owner]: owner,
      [ANT_SPAWN_ADDRESSES.mint]: mint,
    });
    if (quoted !== undefined) transaction = patchSolanaRecentBlockhash(transaction, quoted);

    return accepted({
      ...ANT_SPAWN_DRAFT,
      owner,
      mint,
      processId: mint,
      feePayer: jobEventParam(event, 'feePayer') ?? ANT_SPAWN_DRAFT.feePayer,
      name: jobEventParam(event, 'name') ?? ANT_SPAWN_DRAFT.name,
      transaction,
      requiredSigners: parseSolanaWireTransaction(transaction).signers,
      clientSigners: [owner, mint],
      ...(quoted === undefined ? {} : { recentBlockhash: quoted, draft: false }),
    });
  }
}

/**
 * Rewrite static account keys by address, leaving the compiled layout alone.
 *
 * The store compiles against the keys it is handed; this is the cheapest way to
 * say the same thing about one fixed set of bytes, so a test can spawn with a
 * freshly generated mint and have the transaction really name it.
 */
function substituteAccounts(
  wireBase64: string,
  replacements: Record<string, string>
): string {
  const parsed = parseSolanaWireTransaction(wireBase64);
  const bytes = new Uint8Array(parsed.bytes);
  const keysOffset = parsed.recentBlockhashOffset - parsed.staticAccounts.length * 32;
  for (const [index, account] of parsed.staticAccounts.entries()) {
    const replacement = replacements[account];
    if (replacement !== undefined) {
      bytes.set(base58Decode(replacement), keysOffset + index * 32);
    }
  }
  return toBase64(bytes);
}
