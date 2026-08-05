/**
 * Declaring the client's payment channel on its live BTP session
 * (toon-client#513, connector#790) — an earning agent is never credited
 * because the connector only learns the session→channel association from an
 * inbound claim, i.e. when the client PAYS. `openChannel()`/`adoptChannel()`
 * now re-authenticate the live BTP session with a signed declaration so a
 * pure earner is creditable too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { ChannelManager } from './channel/ChannelManager.js';
import { EvmSigner } from './signing/evm-signer.js';
import { SolanaSigner } from './signing/solana-signer.js';
import { FakeTerminatingConnector } from './wire/fake-connector.test-support.js';

const EVM_CHANNEL_ID = '0x' + 'aa'.repeat(32);
const EVM_TOKEN_NETWORK = '0x' + 'bb'.repeat(20);
const SOLANA_CHANNEL_PDA = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';
const SOLANA_PROGRAM_ID = '11111111111111111111111111111111';

function baseConfig() {
  return {
    secretKey: new Uint8Array(32).fill(7),
    connectorUrl: 'http://connector.test',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

const GREETING_SETTLEMENT = {
  chain: 'evm:84532',
  settlementAddress: '0x' + 'a'.repeat(40),
  tokenNetworkRegistry: '0x' + 'b'.repeat(40),
  tokenNetwork: EVM_TOKEN_NETWORK,
  tokenAddress: '0x' + 'f'.repeat(40),
  decimals: 6,
};

/** A started client with a real ChannelManager (so `getChannelContext` is
 * real) and a fake `btpSession` so declaration wiring is observable without
 * a real WebSocket. */
function startedClient(opts: {
  evmSigner?: EvmSigner;
  solanaSigner?: SolanaSigner;
  ensureChannelResult?: string;
}) {
  const client = new ToonClient(baseConfig());
  const reauthenticate = vi.fn(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).state = {
    bootstrapService: {},
    discoveryTracker: {},
    runtimeClient: {},
    peersDiscovered: 0,
    btpSession: { reauthenticate },
  };
  const cm = new ChannelManager(opts.evmSigner);
  if (opts.solanaSigner) cm.registerChainSigner('solana', opts.solanaSigner);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).channelManager = cm;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (opts.evmSigner) (client as any).evmSigner = opts.evmSigner;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (opts.solanaSigner) (client as any).solanaSigner = opts.solanaSigner;

  const ensureChannel = vi.fn(async () => opts.ensureChannelResult ?? EVM_CHANNEL_ID);
  cm.ensureChannel = ensureChannel;

  return { client, cm, reauthenticate, ensureChannel };
}

let connector: FakeTerminatingConnector;
let realFetch: typeof fetch;

beforeEach(() => {
  connector = new FakeTerminatingConnector();
  connector.settlementTerms = GREETING_SETTLEMENT;
  realFetch = globalThis.fetch;
  globalThis.fetch = connector.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ToonClient — channel declaration on the BTP session (toon-client#513)', () => {
  it('openChannel() declares the newly opened channel on the live BTP session', async () => {
    const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
    const { client, reauthenticate } = startedClient({ evmSigner });

    const channelId = await client.openChannel('g.proxy');

    expect(channelId).toBe(EVM_CHANNEL_ID);
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).declaredChannelId).toBe(EVM_CHANNEL_ID);
  });

  it('adoptChannel() declares the adopted channel on the live BTP session', async () => {
    const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
    const { client, reauthenticate, cm } = startedClient({ evmSigner });
    cm.adoptChannel = vi.fn();

    await client.adoptChannel('g.proxy', EVM_CHANNEL_ID);

    expect(cm.adoptChannel).toHaveBeenCalledWith(
      'g.proxy',
      expect.anything(),
      EVM_CHANNEL_ID
    );
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).declaredChannelId).toBe(EVM_CHANNEL_ID);
  });

  it('openChannel() does not throw when no BTP session is live (btpUrl not configured)', async () => {
    const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
    const { client } = startedClient({ evmSigner });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state.btpSession = undefined;

    await expect(client.openChannel('g.proxy')).resolves.toBe(EVM_CHANNEL_ID);
  });

  describe('buildChannelDeclaration (the reauthenticate() hook)', () => {
    it('signs a claim-state-challenge over the declared EVM channel', async () => {
      const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
      const { client, cm } = startedClient({ evmSigner });
      cm.trackChannel(EVM_CHANNEL_ID, {
        chainType: 'evm',
        chainId: 31337,
        tokenNetworkAddress: EVM_TOKEN_NETWORK,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).declaredChannelId = EVM_CHANNEL_ID;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const declaration = await (client as any).buildChannelDeclaration();

      expect(declaration).toMatchObject({
        blockchain: 'evm',
        channelId: EVM_CHANNEL_ID,
      });
      expect(typeof declaration.expires).toBe('number');
      expect(typeof declaration.signature).toBe('string');
    });

    it('signs a claim-state-challenge over the declared Solana channel', async () => {
      const solanaSigner = new SolanaSigner(new Uint8Array(32).fill(3));
      const { client, cm } = startedClient({ solanaSigner });
      cm.trackChannel(SOLANA_CHANNEL_PDA, {
        chainType: 'solana',
        chainId: 0,
        tokenNetworkAddress: SOLANA_PROGRAM_ID,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).declaredChannelId = SOLANA_CHANNEL_PDA;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const declaration = await (client as any).buildChannelDeclaration();

      expect(declaration).toMatchObject({
        blockchain: 'solana',
        channelAccount: SOLANA_CHANNEL_PDA,
      });
    });

    it('is undefined before any channel has been declared — a client with no channel authenticates as today', async () => {
      const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
      const { client } = startedClient({ evmSigner });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await (client as any).buildChannelDeclaration()).toBeUndefined();
    });

    it('is undefined for a chain type this endpoint does not cover (e.g. Mina) — out of scope, matching getClaimState', async () => {
      const { client, cm } = startedClient({});
      cm.trackChannel('mina-channel', {
        chainType: 'mina',
        chainId: 0,
        tokenNetworkAddress: 'zkapp',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).declaredChannelId = 'mina-channel';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await (client as any).buildChannelDeclaration()).toBeUndefined();
    });
  });
});
