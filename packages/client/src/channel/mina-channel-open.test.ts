import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the on-chain Mina channel opener. o1js and
 * `@toon-protocol/mina-zkapp` are mocked so the initialize/deposit/idempotency
 * control flow is exercised WITHOUT the heavyweight o1js WASM runtime (the live
 * path is covered by the gated Mina smoke loop). We assert:
 *  - UNINITIALIZED → initializeChannel is built+proved+signed+sent
 *  - already-OPEN → idempotent, no initializeChannel tx
 *  - deposit option → deposit tx submitted after init
 *  - missing zkApp account → hard error
 *  - CLOSING/SETTLED → refuses to open
 */

// ── o1js mock ────────────────────────────────────────────────────────────────

const txState = {
  fetchError: undefined as unknown,
  // channelState the zkApp reports on each `.get()`; flips after a successful
  // initialize so the post-call read reflects OPEN.
  channelStateValue: 0n,
};

const initializeChannel = vi.fn(async () => {});
const deposit = vi.fn(async () => {});
const prove = vi.fn(async () => {});
const send = vi.fn(async () => ({
  hash: 'tx-hash-xyz',
  // `.wait()` is awaited before a deposit so the init tx is included on-chain
  // (the deposit precondition reads channelState). The fake resolves instantly.
  wait: vi.fn(async () => ({ status: 'included' })),
}));
const sign = vi.fn(() => ({ send }));
// fetchAccount returns an account whose zkapp.appState[3] is the current
// channelState (the opener reads state from here, not zkApp.channelState.get()).
const fetchAccount = vi.fn(async () => {
  if (txState.fetchError) return { error: txState.fetchError };
  const appState = ['0', '0', '0', String(txState.channelStateValue)].concat(
    Array(4).fill('0')
  );
  return {
    error: undefined,
    account: {
      zkapp: { appState: appState.map((v) => ({ toString: () => v })) },
    },
  };
});

const transaction = vi.fn(async (_pk: unknown, cb: () => Promise<void>) => {
  await cb();
  return { prove, sign };
});

class FakePublicKey {
  constructor(public b58: string) {}
  static fromBase58(b58: string) {
    return new FakePublicKey(b58);
  }
  toBase58() {
    return this.b58;
  }
}
class FakePrivateKey {
  constructor(public b58: string) {}
  static fromBase58(b58: string) {
    return new FakePrivateKey(b58);
  }
  toPublicKey() {
    return new FakePublicKey('B62qPAYER');
  }
}
const Field = (v: unknown) => ({
  toString: () => String(v),
});

const fakeO1js = {
  Mina: {
    Network: vi.fn(() => ({})),
    setActiveInstance: vi.fn(),
    transaction,
  },
  PrivateKey: FakePrivateKey,
  PublicKey: FakePublicKey,
  Field,
  AccountUpdate: { fundNewAccount: vi.fn() },
  fetchAccount,
};

// ── @toon-protocol/mina-zkapp mock ───────────────────────────────────────────

const compile = vi.fn(async () => {});
class FakePaymentChannel {
  static compile = compile;
  channelState = {
    get: () => Field(txState.channelStateValue),
  };
  initializeChannel = initializeChannel;
  deposit = deposit;
  constructor(public addr: unknown) {}
}

// The production loader resolves o1js + the contract through a CJS `require`
// (so o1js's active-instance closure is shared with the CJS zkApp) — vitest's
// `vi.mock` can't intercept that, so we inject fakes via the test hook instead.
const {
  openMinaChannelOnChain,
  _resetMinaChannelOpenCache,
  _setMinaRuntimeForTests,
} = await import('./mina-channel-open.js');
_setMinaRuntimeForTests(async () => ({
  o1js: fakeO1js as never,
  PaymentChannel: FakePaymentChannel,
}));

const ZKAPP = 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyJvpW2im7T5sa';
const APEX = 'B62qksocUTe3wxR3uHB9oV7yWZi6JdkWLwNDvVoUkbXkmTGwHo3rDNc';
const PK = 'EKPAYERkeybase58';

describe('openMinaChannelOnChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMinaChannelOpenCache();
    txState.fetchError = undefined;
    txState.channelStateValue = 0n; // UNINITIALIZED by default
  });
  afterEach(() => {
    _resetMinaChannelOpenCache();
  });

  it('initializes an UNINITIALIZED channel (compile + initializeChannel tx)', async () => {
    // After init the zkApp reports OPEN.
    initializeChannel.mockImplementationOnce(async () => {
      txState.channelStateValue = 1n;
    });
    const res = await openMinaChannelOnChain({
      graphqlUrl: 'http://localhost:28085/graphql',
      zkAppAddress: ZKAPP,
      payerPrivateKey: PK,
      peerPublicKey: APEX,
    });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(initializeChannel).toHaveBeenCalledTimes(1);
    expect(prove).toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
    expect(res.opened).toBe(true);
    expect(res.initTxHash).toBe('tx-hash-xyz');
    expect(res.zkAppAddress).toBe(ZKAPP);
    expect(res.channelState).toBe(1);
    expect(deposit).not.toHaveBeenCalled();
  });

  it('is idempotent when the channel is already OPEN (no initializeChannel)', async () => {
    txState.channelStateValue = 1n; // OPEN
    const res = await openMinaChannelOnChain({
      graphqlUrl: 'http://localhost:28085/graphql',
      zkAppAddress: ZKAPP,
      payerPrivateKey: PK,
      peerPublicKey: APEX,
    });
    expect(initializeChannel).not.toHaveBeenCalled();
    expect(res.opened).toBe(false);
    expect(res.initTxHash).toBeUndefined();
    expect(res.channelState).toBe(1);
  });

  it('submits a deposit tx after initialization when a deposit is requested', async () => {
    initializeChannel.mockImplementationOnce(async () => {
      txState.channelStateValue = 1n;
    });
    const res = await openMinaChannelOnChain({
      graphqlUrl: 'http://localhost:28085/graphql',
      zkAppAddress: ZKAPP,
      payerPrivateKey: PK,
      peerPublicKey: APEX,
      deposit: { amount: 5_000_000n },
    });
    expect(initializeChannel).toHaveBeenCalledTimes(1);
    expect(deposit).toHaveBeenCalledTimes(1);
    expect(res.depositTxHash).toBe('tx-hash-xyz');
  });

  it('does not deposit when amount is zero', async () => {
    txState.channelStateValue = 1n; // already OPEN
    await openMinaChannelOnChain({
      graphqlUrl: 'http://localhost:28085/graphql',
      zkAppAddress: ZKAPP,
      payerPrivateKey: PK,
      deposit: { amount: 0n },
    });
    expect(deposit).not.toHaveBeenCalled();
  });

  it('throws when the zkApp account is not found on-chain', async () => {
    txState.fetchError = 'account not found';
    await expect(
      openMinaChannelOnChain({
        graphqlUrl: 'http://localhost:28085/graphql',
        zkAppAddress: ZKAPP,
        payerPrivateKey: PK,
        peerPublicKey: APEX,
      })
    ).rejects.toThrow(/not found on-chain/i);
    expect(initializeChannel).not.toHaveBeenCalled();
  });

  it('refuses to open a CLOSING/SETTLED channel', async () => {
    txState.channelStateValue = 2n; // CLOSING
    await expect(
      openMinaChannelOnChain({
        graphqlUrl: 'http://localhost:28085/graphql',
        zkAppAddress: ZKAPP,
        payerPrivateKey: PK,
        peerPublicKey: APEX,
      })
    ).rejects.toThrow(/not UNINITIALIZED\/OPEN/i);
    expect(initializeChannel).not.toHaveBeenCalled();
  });
});
