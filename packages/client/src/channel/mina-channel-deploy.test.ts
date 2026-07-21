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
  constructor(
    public b58: string,
    public pub: string
  ) {}
  static fromBase58(b58: string) {
    // The payer key maps to B62qCLIENT; any other key (e.g. a recorded zkApp
    // key on redeploy) derives its OWN distinct public key so the redeployed
    // address is not confused with the fee payer.
    return new FakePrivateKey(
      b58,
      b58 === 'EKPAYERkeybase58' ? 'B62qCLIENT' : `B62qZK_${b58}`
    );
  }
  static random() {
    freshCounter += 1;
    return new FakePrivateKey(
      `EKFRESH${freshCounter}`,
      `B62qFRESH${freshCounter}`
    );
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

/** Fee-payer (B62qCLIENT) on-chain MINA balance the preflight reads (nanomina).
 *  undefined = account does not exist on-chain (0 MINA). */
let payerBalanceNanomina: bigint | undefined = 5_000_000_000n; // 5 MINA, funded
const fetchAccount = vi.fn(
  async ({ publicKey }: { publicKey: FakePublicKey }) => {
    const address = publicKey.toBase58();
    if (address === 'B62qCLIENT') {
      if (payerBalanceNanomina === undefined) {
        return { error: 'account not found', account: undefined };
      }
      return {
        error: undefined,
        account: { balance: { toString: () => String(payerBalanceNanomina) } },
      };
    }
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
  }
);

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

const { _resetMinaChannelOpenCache, _setMinaRuntimeForTests } =
  await import('./mina-channel-open.js');
const { deployMinaChannelZkApp, ensureOwnedMinaZkApp } =
  await import('./mina-channel-deploy.js');
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
    payerBalanceNanomina = 5_000_000_000n;
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

  it('reuses a recorded key when the prior deploy never landed on-chain (no orphan)', async () => {
    // Our recorded deployment whose account is NOT on chain (deploy tx was
    // persisted before it confirmed, then crashed). The retry must redeploy
    // the SAME key/address — never mint a brand-new ~1.1-MINA zkApp.
    const result = await ensureOwnedMinaZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      peerPublicKey: PEER,
      deployed: {
        zkAppAddress: 'B62qZK_EKRECORDEDpending',
        zkAppPrivateKey: 'EKRECORDEDpending',
      },
    });
    expect(result.deployed).toBe(true);
    expect(result.zkAppAddress).toBe('B62qZK_EKRECORDEDpending');
    // The recorded key is reused; no fresh random zkApp key was generated.
    expect(freshCounter).toBe(0);
    expect(signedWith).toEqual(['EKPAYERkeybase58', 'EKRECORDEDpending']);
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
    payerBalanceNanomina = 5_000_000_000n;
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

  // ── Bug #1: fee-payer preflight (fail fast, no wasted compile) ──────────────

  it('throws a funded-wallet error BEFORE compiling when the fee payer has no account', async () => {
    payerBalanceNanomina = undefined; // account does not exist on-chain
    await expect(
      deployMinaChannelZkApp({ graphqlUrl: GRAPHQL, payerPrivateKey: PK })
    ).rejects.toThrow(/B62qCLIENT.*does not exist on-chain.*Fund/s);
    // The whole point: the multi-minute compile never ran, and no tx was built.
    expect(compile).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('throws when the fee payer exists but is below the required minimum', async () => {
    payerBalanceNanomina = 500_000_000n; // 0.5 MINA — under 1 MINA creation fee
    await expect(
      deployMinaChannelZkApp({ graphqlUrl: GRAPHQL, payerPrivateKey: PK })
    ).rejects.toThrow(/holds only 0\.500 MINA.*needs/s);
    expect(compile).not.toHaveBeenCalled();
  });

  // ── Bug #3: persist the zkApp key BEFORE the deploy is attempted ─────────────

  it('fires onDeploying with the fresh key BEFORE compiling or sending', async () => {
    const order: string[] = [];
    compile.mockImplementationOnce(async () => {
      order.push('compile');
      return { verificationKey: { hash: { toString: () => 'vk-hash-1' } } };
    });
    send.mockImplementationOnce(async () => {
      order.push('send');
      if (lastDeployedAddress) {
        chain.set(lastDeployedAddress, { channelHash: '0', channelState: 0n });
      }
      return { hash: 'deploy-tx-1', wait: waitForInclusion };
    });
    await deployMinaChannelZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      onDeploying: (rec) => {
        order.push(`deploying:${rec.zkAppAddress}`);
        expect(rec.zkAppPrivateKey).toBe('EKFRESH1');
        expect(rec.feePayer).toBe('B62qCLIENT');
      },
    });
    // The key is persisted first, THEN the circuit compiles, THEN the tx sends.
    expect(order).toEqual(['deploying:B62qFRESH1', 'compile', 'send']);
  });

  it('redeploys the SAME address from a provided key instead of minting a fresh one', async () => {
    const record = await deployMinaChannelZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      zkAppPrivateKey: 'EKRECORDEDpending',
    });
    // Same key/address reused — no PrivateKey.random() minted a new zkApp.
    expect(record.zkAppAddress).toBe('B62qZK_EKRECORDEDpending');
    expect(record.zkAppPrivateKey).toBe('EKRECORDEDpending');
    expect(freshCounter).toBe(0);
    // The deploy tx is signed by the payer + the RECORDED zkApp key.
    expect(signedWith).toEqual(['EKPAYERkeybase58', 'EKRECORDEDpending']);
  });

  it('does NOT re-fire onDeploying when redeploying a provided (already-persisted) key', async () => {
    const onDeploying = vi.fn();
    await deployMinaChannelZkApp({
      graphqlUrl: GRAPHQL,
      payerPrivateKey: PK,
      zkAppPrivateKey: 'EKRECORDEDpending',
      onDeploying,
    });
    expect(onDeploying).not.toHaveBeenCalled();
  });
});
