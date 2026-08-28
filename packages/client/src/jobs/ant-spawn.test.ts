/**
 * The ceremony that buys an ArNS name with no SOL.
 *
 * The fake network these tests drive is not a mock with canned answers. Its gas
 * station half applies the checks a real one applies before it spends — the
 * transaction carries the blockhash IT quoted, and every slot but the fee
 * payer's holds a signature that verifies over the message — and its store half
 * composes deterministically, returning the same bytes but for the blockhash
 * when asked to prepare again. So a driver that signed before patching, or read
 * `requiredSigners` positionally, fails here with the reason string it would
 * come back with from devnet.
 *
 * What is asserted, beyond "it worked":
 *
 *   - the ORDER of the four jobs, and that each goes to the right node;
 *   - that the first quote carries no draft (it exists only to learn the fee
 *     payer) and the second carries a SIGNED one (that is what makes the free
 *     quote a full policy dry run);
 *   - that the executed transaction is the drafted one with the quoted
 *     blockhash — not a recompilation;
 *   - that every refusal is RETURNED, with the vocabulary the caller branches on.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSolanaWireTransaction,
  solanaKeypair,
} from '../channel/solana/wire-transaction.js';
import { jobEventParam } from './job-event.js';
import {
  buyArnsName,
  buyArnsNameWithNewAnt,
  spawnAnt,
  type AntSpawnParams,
} from './ant-spawn.js';
import {
  ANT_SPAWN_ADDRESSES,
  ANT_SPAWN_DRAFT,
  ANT_SPAWN_SEEDS,
  ANT_SPAWN_TRANSACTION,
  FakeJobNetwork,
  QUOTED_BLOCKHASH,
  accepted,
  refused,
  rejected,
} from './ant-spawn.test-support.js';

const owner = solanaKeypair(ANT_SPAWN_SEEDS.owner);
const mint = solanaKeypair(ANT_SPAWN_SEEDS.mint);

function harness(overrides: Partial<AntSpawnParams> = {}) {
  const network = new FakeJobNetwork();
  const params: AntSpawnParams = {
    store: { client: network, destination: network.routes.store },
    gas: { client: network, destination: network.routes.gas },
    owner,
    mint,
    name: 'toon-fixture',
    ...overrides,
  };
  return { network, params };
}

describe('spawnAnt', () => {
  it('drives quote → prepare → quote → execute, in that order', async () => {
    const { network, params } = harness();

    const result = await spawnAnt(params);

    expect(result.spawned).toBe(true);
    if (!result.spawned) throw new Error(result.detail);
    expect(result).toMatchObject({
      processId: ANT_SPAWN_ADDRESSES.mint,
      mint: ANT_SPAWN_ADDRESSES.mint,
      owner: ANT_SPAWN_ADDRESSES.owner,
      feePayer: ANT_SPAWN_ADDRESSES.feePayer,
      quoteId: 'quote-1',
      recentBlockhash: QUOTED_BLOCKHASH,
      signature: '5'.repeat(87),
      slot: '312000000',
      replayed: false,
    });

    expect(network.jobs.map((job) => [job.destination, job.event.kind])).toEqual([
      ['g.toon.gas', 5096],
      ['g.toon.store', 5095],
      ['g.toon.gas', 5096],
      ['g.toon.gas', 5096],
    ]);
  });

  it('asks the first quote for a fee payer and nothing else', async () => {
    const { network, params } = harness();
    await spawnAnt(params);

    // No draft: the store cannot compose until it knows the gas wallet, so this
    // round trip exists to learn one address.
    expect(network.paramsOf(0)).toEqual({ phase: 'quote' });
  });

  it('hands the store the three keys, and no blockhash', async () => {
    const { network, params } = harness({ target: 'a'.repeat(43), ticker: 'TOON' });
    await spawnAnt(params);

    expect(network.paramsOf(1)).toEqual({
      op: 'prepare',
      name: 'toon-fixture',
      owner: ANT_SPAWN_ADDRESSES.owner,
      mint: ANT_SPAWN_ADDRESSES.mint,
      feePayer: ANT_SPAWN_ADDRESSES.feePayer,
      target: 'a'.repeat(43),
      ticker: 'TOON',
    });
    // A prepare with no blockhash is a DRAFT: it exists to be priced, and the
    // gas station simulates it with `replaceRecentBlockhash`.
    expect(network.paramsOf(1)['recentBlockhash']).toBeUndefined();
  });

  it('prices a SIGNED draft, so the free quote is a full policy dry run', async () => {
    const { network, params } = harness();
    await spawnAnt(params);

    const draft = network.paramsOf(2)['transaction'];
    expect(draft).toBeDefined();
    const parsed = parseSolanaWireTransaction(draft ?? '');
    expect(parsed.unsigned).toEqual([ANT_SPAWN_ADDRESSES.feePayer]);
    // Still the placeholder: the quote is what chooses the real blockhash.
    expect(parsed.recentBlockhash).toBe('11111111111111111111111111111111');
  });

  it('executes the drafted bytes with the quoted blockhash — not a rebuild', async () => {
    const { network, params } = harness();
    const result = await spawnAnt(params);
    if (!result.spawned) throw new Error(result.detail);

    const executed = network.paramsOf(3)['transaction'];
    expect(executed).toBe(result.transaction);
    const parsed = parseSolanaWireTransaction(executed ?? '');
    expect(parsed.recentBlockhash).toBe(QUOTED_BLOCKHASH);
    expect(parsed.unsigned).toEqual([ANT_SPAWN_ADDRESSES.feePayer]);
    // The message is the draft's, moved 32 bytes and not one more.
    const draft = parseSolanaWireTransaction(ANT_SPAWN_TRANSACTION);
    expect(parsed.staticAccounts).toEqual(draft.staticAccounts);
    expect(parsed.bytes.length).toBe(draft.bytes.length);
  });

  it('carries a fresh UUID as the idempotency key, and reports it', async () => {
    const { network, params } = harness();
    const result = await spawnAnt(params);
    if (!result.spawned) throw new Error(result.detail);

    // That store is global and unscoped on the gas station's side, so a
    // guessable key is somebody else's receipt.
    expect(result.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(network.paramsOf(3)['idempotencyKey']).toBe(result.idempotencyKey);
    expect(network.paramsOf(3)['quoteId']).toBe('quote-1');
  });

  it('reuses the caller\'s idempotency key, which is how a timeout is retried', async () => {
    const { network, params } = harness({ idempotencyKey: 'retry-me' });
    await spawnAnt(params);
    expect(network.paramsOf(3)['idempotencyKey']).toBe('retry-me');
  });

  it('generates a single-use mint when none is supplied', async () => {
    const { network, params } = harness({ mint: undefined });
    const result = await spawnAnt(params);
    if (!result.spawned) throw new Error(result.detail);

    expect(result.mint).not.toBe(ANT_SPAWN_ADDRESSES.mint);
    expect(result.processId).toBe(result.mint);
    expect(network.paramsOf(1)['mint']).toBe(result.mint);
  });

  it('re-prepares instead of patching when asked, and lands in the same place', async () => {
    const { network, params } = harness({ reprepare: true });
    const patched = await spawnAnt(harness().params);
    const result = await spawnAnt(params);

    if (!result.spawned || !patched.spawned) throw new Error('spawn refused');
    expect(network.jobs.map((job) => job.destination)).toEqual([
      'g.toon.gas',
      'g.toon.store',
      'g.toon.gas',
      'g.toon.store', // the extra round trip, inside the quote TTL
      'g.toon.gas',
    ]);
    expect(network.paramsOf(3)['recentBlockhash']).toBe(QUOTED_BLOCKHASH);
    // A byte-identical transaction, arrived at two ways.
    expect(result.transaction).toBe(patched.transaction);
  });
});

describe('spawnAnt refusals', () => {
  it('returns the gate\'s own reason when it declines to quote', async () => {
    const { network, params } = harness();
    network.answers.push(
      accepted({
        job: 'gas-station',
        phase: 'quote',
        status: 'failed',
        network: 'devnet',
        reason: 'float_exhausted',
        detail: 'fee-payer float 0 lamports cannot cover this job',
      })
    );

    const result = await spawnAnt(params);
    expect(result).toMatchObject({
      spawned: false,
      step: 'fee-payer-quote',
      reason: 'float_exhausted',
    });
    // Nothing was composed, so nothing else was paid for.
    expect(network.jobs).toHaveLength(1);
  });

  it('returns a packet refusal without throwing it', async () => {
    const { network, params } = harness();
    network.answers.push(undefined, refused('F03', 'insufficient amount'));

    const result = await spawnAnt(params);
    expect(result).toMatchObject({ spawned: false, step: 'prepare', reason: 'F03' });
    if (result.spawned) throw new Error('unreachable');
    expect(result.refusal?.refusedBy).toBe('destination');
    // The mint is named even though it was never used, so a log can be read back.
    expect(result.mint).toBe(ANT_SPAWN_ADDRESSES.mint);
  });

  it('returns the store\'s rejection of a bad param', async () => {
    const { network, params } = harness({ name: 'Not A Name' });
    network.answers.push(
      undefined,
      rejected('F00', 'invalid ArNS name "Not A Name" — 1–51 lowercase…')
    );

    expect(await spawnAnt(params)).toMatchObject({
      spawned: false,
      step: 'prepare',
      reason: 'F00',
    });
  });

  it('returns a failed execute — including one to retry with the same key', async () => {
    const { network, params } = harness();
    network.answers.push(
      undefined,
      undefined,
      undefined,
      accepted({
        job: 'gas-station',
        phase: 'execute',
        status: 'failed',
        network: 'devnet',
        reason: 'confirmation_timeout',
        detail: 'broadcast but not confirmed within 30000ms',
      })
    );

    expect(await spawnAnt(params)).toMatchObject({
      spawned: false,
      step: 'execute',
      reason: 'confirmation_timeout',
    });
  });

  it('refuses when the store asks for a signature this client cannot make', async () => {
    const { network, params } = harness();
    const stranger = 'GsbwXfJraMomNxBcpR3DBNxnKwzYK7kkYm2XoNqLdvJH';
    network.answers.push(
      undefined,
      accepted({
        job: 'arns-buy',
        op: 'prepare',
        network: 'devnet',
        processId: ANT_SPAWN_ADDRESSES.mint,
        mint: ANT_SPAWN_ADDRESSES.mint,
        owner: stranger,
        feePayer: ANT_SPAWN_ADDRESSES.feePayer,
        name: 'toon-fixture',
        antProgramId: 'DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX',
        transaction: ANT_SPAWN_TRANSACTION,
        recentBlockhash: '11111111111111111111111111111111',
        draft: true,
        requiredSigners: [ANT_SPAWN_ADDRESSES.feePayer, stranger, ANT_SPAWN_ADDRESSES.mint],
        clientSigners: [stranger, ANT_SPAWN_ADDRESSES.mint],
        rentTransferLamports: '9242880',
        estimatedFeePayerLamports: '12271560',
        instructions: [],
      })
    );

    // Two packets have already been paid for by the time this receipt is read,
    // so it is a refusal and not an exception — the same rule the rest of this
    // client follows. Nothing was signed and nothing was sent to execute.
    const result = await spawnAnt(params);
    expect(result).toMatchObject({
      spawned: false,
      step: 'prepare',
      reason: 'malformed_receipt',
    });
    if (result.spawned) throw new Error('unreachable');
    expect(result.detail).toMatch(/needs signatures this client does not hold/);
    // Nothing was signed, and the execute was never paid for.
    expect(network.jobs).toHaveLength(2);
  });

  it('refuses a receipt that spawns something other than the mint it was given', async () => {
    const { network, params } = harness();
    const stranger = 'GsbwXfJraMomNxBcpR3DBNxnKwzYK7kkYm2XoNqLdvJH';
    network.answers.push(
      undefined,
      accepted({ ...ANT_SPAWN_DRAFT, processId: stranger })
    );

    // The mint's public half IS the ANT's address. A processId that is not it
    // would send the follow-up name purchase at somebody else's asset.
    const result = await spawnAnt(params);
    expect(result).toMatchObject({
      spawned: false,
      step: 'prepare',
      reason: 'malformed_receipt',
    });
    if (result.spawned) throw new Error('unreachable');
    expect(result.detail).toMatch(new RegExp(`spawns ${stranger}`));
    expect(network.jobs).toHaveLength(2);
  });

  it('carries the key and bytes a confirmation_timeout must be retried with', async () => {
    const { network, params } = harness({ idempotencyKey: 'retry-me' });
    network.answers.push(
      undefined,
      undefined,
      undefined,
      accepted({
        job: 'gas-station',
        phase: 'execute',
        status: 'failed',
        network: 'devnet',
        reason: 'confirmation_timeout',
        detail: 'broadcast, not confirmed within the window',
      })
    );

    // Broadcast but unconfirmed: it may yet land, so the recovery is to ask
    // again with the same key rather than to build a second transaction.
    const result = await spawnAnt(params);
    expect(result).toMatchObject({
      spawned: false,
      step: 'execute',
      reason: 'confirmation_timeout',
      idempotencyKey: 'retry-me',
    });
    if (result.spawned) throw new Error('unreachable');
    expect(result.quoteId).toBe(network.quoteId);
    const execute = network.jobs[3]?.event;
    expect(result.transaction).toBe(
      execute && jobEventParam(execute, 'transaction')
    );
  });
});

describe('buyArnsName', () => {
  it('registers a lease by default', async () => {
    const network = new FakeJobNetwork();
    const result = await buyArnsName({
      store: { client: network, destination: network.routes.store },
      name: 'toon-fixture',
      processId: ANT_SPAWN_ADDRESSES.mint,
    });

    expect(network.paramsOf(0)).toEqual({
      op: 'buy',
      name: 'toon-fixture',
      processId: ANT_SPAWN_ADDRESSES.mint,
      type: 'lease',
    });
    expect(result).toMatchObject({ bought: true });
  });

  it('sends years for a lease and never for a permabuy', async () => {
    const network = new FakeJobNetwork();
    const store = { client: network, destination: network.routes.store };

    await buyArnsName({ store, name: 'a', processId: 'p', years: 3 });
    await buyArnsName({ store, name: 'b', processId: 'p', type: 'permabuy', years: 3 });

    expect(network.paramsOf(0)['years']).toBe('3');
    // The store refuses `years` on a permabuy outright, so it must not be sent.
    expect(network.paramsOf(1)['years']).toBeUndefined();
  });

  it('returns the store\'s refusal rather than throwing it', async () => {
    const network = new FakeJobNetwork();
    network.answers.push(rejected('T00', 'arns-buy failed: insufficient ARIO'));

    expect(
      await buyArnsName({
        store: { client: network, destination: network.routes.store },
        name: 'toon-fixture',
        processId: ANT_SPAWN_ADDRESSES.mint,
      })
    ).toMatchObject({ bought: false, reason: 'T00' });
  });
});

describe('buyArnsNameWithNewAnt', () => {
  it('spawns then buys, and hands the spawned processId to the buy', async () => {
    const { network, params } = harness();

    const result = await buyArnsNameWithNewAnt({ ...params, years: 2 });
    expect(result.bought).toBe(true);
    if (!result.bought) throw new Error(result.detail);
    expect(result.ant.processId).toBe(ANT_SPAWN_ADDRESSES.mint);
    expect(network.paramsOf(4)).toEqual({
      op: 'buy',
      name: 'toon-fixture',
      processId: ANT_SPAWN_ADDRESSES.mint,
      type: 'lease',
      years: '2',
    });
  });

  it('keeps the ANT when only the buy fails, so it need not be spawned twice', async () => {
    const { network, params } = harness();
    network.answers.push(
      undefined,
      undefined,
      undefined,
      undefined,
      rejected('T00', 'arns-buy failed: insufficient ARIO')
    );

    const result = await buyArnsNameWithNewAnt(params);
    expect(result).toMatchObject({ bought: false, step: 'buy', reason: 'T00' });
    if (result.bought) throw new Error('unreachable');
    expect(result.ant?.processId).toBe(ANT_SPAWN_ADDRESSES.mint);
  });

  it('reports the step a spawn stopped at, and buys nothing', async () => {
    const { network, params } = harness();
    network.answers.push(refused('F02', 'no route'));

    expect(await buyArnsNameWithNewAnt(params)).toMatchObject({
      bought: false,
      step: 'fee-payer-quote',
      reason: 'F02',
    });
    expect(network.jobs).toHaveLength(1);
  });
});
