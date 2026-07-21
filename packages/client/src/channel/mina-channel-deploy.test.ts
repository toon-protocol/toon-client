import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the per-pair Mina zkApp auto-deploy. o1js and
 * `@toon-protocol/mina-zkapp` are injected fakes (the production loader's CJS
 * `require` path cannot be vi.mock'd), so the ownership decision table and the
 * deploy control flow are exercised WITHOUT the o1js WASM runtime:
 *  - candidate OPEN with OUR pair hash → reuse, no deploy
 *  - own recorded deployment still UNINITIALIZED → reuse (crash recovery)
 *  - foreign pair / missing account → fresh deploy (fundNewAccount + both keys)
 *  - onDeployed fires BEFORE ensureOwnedMinaZkApp returns
 *  - inclusion-poll timeout → hard error naming the tx
 */

// ── fakes ────────────────────────────────────────────────────────────────────

/** On-chain world: address → zkApp appState (absent = no account). */
const chain = new Map<string, { channelHash: string; channelState: bigint }>();

class FakePublicKey {
  constructor(public b58: string) {}
  static fromBase58(b58: string) {
    return new FakePublicKey(b58);
  }
  toBase58() {
    return this.b58;
  }
  get x() {
    return `x(${this.b58})`;
  }
}

let freshCounter = 0;
class FakePrivateKey {
  constructor(public b58: string, public pub: string) {}
  static fromBase58(b58: string) {
    return new FakePrivateKey(b58, 'B62qCLIENT');
  }
  static random() {
    freshCounter += 1;
    return new FakePrivateKey(`EKFRESH${freshCounter}`, `B62qFRESH${freshCounter}`);
  }
  toPublicKey() {
    return new FakePublicKey(this.pub);
  }
  toBase58() {
    return this.b58;
  }
}

const Field = (v: unknown) => ({ toString: () => String(v) });
const Poseidon = {
  hash: (inputs: unknown[]) => ({
    toString: () => `poseidon(${inputs.map(String).join(',')})`,
  }),
};

const fetchAccount = vi.fn(async ({ publicKey }: { publicKey: FakePublicKey }) => {
  const address = publicKey.toBase58();
  if (address === 'B62qCLIENT') return { error: undefined, account: {} };
  const entry = chain.get(address);
  if (!entry) return { error: 'account not found', account: undefined };
  const appState = [
    entry.channelHash,
    '0',
    '0',
    String(entry.channelState),
    '0',
    '0',
    '0',
    '0',
  ];
  return {
    error: undefined,
    account: {
      zkapp: { appState: appState.map((v) => ({ toString: () => v })) },
    },
  };
});

const prove = vi.fn(async () => {});
const waitForInclusion = vi.fn(async () => ({ status: 'included' }));
/** Keys `.sign()` was called with on the deploy tx. */
let signedWith: string[] = [];
/** When true, `send` "includes" the deployed account on the fake chain. */
const sendBehavior = { landAccount: true };
let lastDeployedAddress: string | undefined;
const send = vi.fn(async () => {
  if (sendBehavior.landAccount && lastDeployedAddress) {
    chain.set(lastDeployedAddress, { channelHash: '0', channelState: 0n });
  }
  return { hash: 'deploy-tx-1', wait: waitForInclusion };
});
const sign = vi.fn((keys: FakePrivateKey[]) => {
  signedWith = keys.map((k) => k.toBase58());
  return { send };
});
const transaction = vi.fn(async (_opts: unknown, cb: () => Promise<void>) => {
  await cb();
  return { prove, sign };
});
const fundNewAccount = vi.fn();

const fakeO1js = {
  Mina: {
    Network: vi.fn(() => ({})),
    setActiveInstance: vi.fn(),
    transaction,
  },
  PrivateKey: FakePrivateKey,
  PublicKey: FakePublicKey,
  Field,
  Poseidon,
  AccountUpdate: { fundNewAccount },
  fetchAccount,
};

const compile = vi.fn(async () => ({
  verificationKey: { hash: { toString: () => 'vk-hash-1' } },
}));
class FakePaymentChannel {
  static compile = compile;
  deployed: string;
  constructor(public addr: FakePublicKey) {
    this.deployed = addr.toBase58();
  }
  async deploy() {
    lastDeployedAddress = this.deployed;
  }
}

const { _resetMinaChannelOpenCache, _setMinaRuntimeForTests } = await import(
  './mina-channel-open.js'
);
const { deployMinaChannelZkApp, ensureOwnedMinaZkApp } = await import(
  './mina-channel-deploy.js'
);
_setMinaRuntimeForTests(async () => ({
  o1js: fakeO1js as never,
  PaymentChannel: FakePaymentChannel,
}));

const GRAPHQL = 'http://localhost:28085/graphql';
const PK = 'EKPAYERkeybase58';
const PEER = 'B62qPEER';
/** The pair hash the fakes produce for (client, PEER, nonce 0). */
const OUR_HASH = 'poseidon(x(B62qCLIENT),x(B62qPEER),0)';
const ANNOUNCED = 'B62qANNOUNCED';
const RECORDED = 'B62qRECORDED';

describe('ensureOwnedMinaZkApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chain.clear();
    signedWith = [];
    sendBehavior.landAccount = true;
    lastDeployedAddress = undefined;
    freshCounter = 0;
  });
  afterEach(() => {
    _resetMinaChannelOpenCache();
    _setMinaRuntimeForTests(async () => ({
      o1js: fakeO1js as never,
      PaymentChannel: FakePaymentChannel,
    }));
  });

  it('reuses a candidate that is OPEN for exactly our pair (no deploy)', async () => {
    chain.set(ANNOUNCED, { channelHash: OUR_HASH, channelState: 1n });
    const result = await ensureOwnedMinaZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      peerPublicKey: PEER,
      candidateZkAppAddress: ANNOUNCED,
    });
    expect(result).toEqual({ zkAppAddress: ANNOUNCED, deployed: false });
    expect(transaction).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  it('reuses our recorded deployment when it is still UNINITIALIZED', async () => {
    chain.set(RECORDED, { channelHash: '0', channelState: 0n });
    const result = await ensureOwnedMinaZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      peerPublicKey: PEER,
      deployed: { zkAppAddress: RECORDED, zkAppPrivateKey: 'EKRECORDED' },
      candidateZkAppAddress: ANNOUNCED,
    });
    expect(result).toEqual({ zkAppAddress: RECORDED, deployed: false });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('an UNINITIALIZED zkApp that is NOT ours (announce candidate) is not reused', async () => {
    // The shared announce zkApp is bare — but it is not our record, and a
    // bare shared zkApp must not be claimed (another identity may be racing
    // to initialize it; single-pair means first-init wins forever).
    chain.set(ANNOUNCED, { channelHash: '0', channelState: 0n });
    const result = await ensureOwnedMinaZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      peerPublicKey: PEER,
      candidateZkAppAddress: ANNOUNCED,
    });
    expect(result.deployed).toBe(true);
    expect(result.zkAppAddress).toBe('B62qFRESH1');
  });

  it('a foreign pair’s OPEN channel triggers a fresh deploy with both signers', async () => {
    chain.set(ANNOUNCED, {
      channelHash: 'poseidon(x(B62qSOMEONE),x(B62qPEER),0)',
      channelState: 1n,
    });
    const events: string[] = [];
    const result = await ensureOwnedMinaZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      peerPublicKey: PEER,
      candidateZkAppAddress: ANNOUNCED,
      onDeployed: (record) => {
        events.push(`deployed:${record.zkAppAddress}`);
        expect(record.zkAppPrivateKey).toBe('EKFRESH1');
        expect(record.feePayer).toBe('B62qCLIENT');
        expect(record.deployTxHash).toBe('deploy-tx-1');
        expect(record.vkHash).toBe('vk-hash-1');
      },
    });
    events.push('returned');
    // onDeployed fires BEFORE the ensure returns (key persisted first).
    expect(events).toEqual(['deployed:B62qFRESH1', 'returned']);
    expect(result).toMatchObject({
      zkAppAddress: 'B62qFRESH1',
      deployed: true,
    });
    // The deploy tx funds the new account and is signed by payer + zkApp key.
    expect(fundNewAccount).toHaveBeenCalledTimes(1);
    expect(signedWith).toEqual(['EKPAYERkeybase58', 'EKFRESH1']);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('a missing candidate account falls through to a fresh deploy', async () => {
    const result = await ensureOwnedMinaZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      peerPublicKey: PEER,
      candidateZkAppAddress: ANNOUNCED, // not on chain at all
    });
    expect(result.deployed).toBe(true);
  });

  it('progress lines cover compile, deploy, and inclusion phases', async () => {
    const lines: string[] = [];
    await ensureOwnedMinaZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      peerPublicKey: PEER,
      onProgress: (line) => lines.push(line),
    });
    const text = lines.join('\n');
    expect(text).toContain('compiling');
    expect(text).toContain('deploying a dedicated PaymentChannel zkApp');
    expect(text).toContain('on-chain');
  });
});

describe('deployMinaChannelZkApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chain.clear();
    signedWith = [];
    sendBehavior.landAccount = true;
    lastDeployedAddress = undefined;
    freshCounter = 0;
  });
  afterEach(() => {
    _resetMinaChannelOpenCache();
    _setMinaRuntimeForTests(async () => ({
      o1js: fakeO1js as never,
      PaymentChannel: FakePaymentChannel,
    }));
  });

  it('returns the full record once the account is resolvable on-chain', async () => {
    const record = await deployMinaChannelZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
    });
    expect(record).toEqual({
      zkAppAddress: 'B62qFRESH1',
      zkAppPrivateKey: 'EKFRESH1',
      feePayer: 'B62qCLIENT',
      deployTxHash: 'deploy-tx-1',
      vkHash: 'vk-hash-1',
    });
    expect(waitForInclusion).toHaveBeenCalled();
  });

  it('times out with an actionable error when the account never appears', async () => {
    sendBehavior.landAccount = false; // tx sent but never included
    await expect(
      deployMinaChannelZkApp({
        graphqlUrl: GRAPHQL,
        payerPrivateKey: PK,
        pollIntervalMs: 1,
        pollTimeoutMs: 10,
      })
    ).rejects.toThrow(/did not appear on-chain.*deploy-tx-1/s);
  });
});
