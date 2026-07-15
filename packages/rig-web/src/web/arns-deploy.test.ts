// ArNS permanent-deploy step (issue #366).
//
// SAFETY: every money-moving path (buyName / setBaseNameRecord) is exercised
// ONLY against in-memory mocks of the @ar.io/sdk surface. No real ar.io
// registry call is made and no $ARIO / Solana funds are spent anywhere in this
// suite — the module never imports @ar.io/sdk, the clients are injected.

import { describe, it, expect, vi } from 'vitest';
import {
  readArnsConfig,
  isValidArnsName,
  quoteBuyName,
  buyName,
  pointNameAtManifest,
  buildArnsUrl,
  runArnsRedeployStep,
  DEFAULT_ARNS_GATEWAY,
  DEFAULT_ARNS_TTL_SECONDS,
  MARIO_PER_ARIO,
} from './arns-deploy.js';
import type {
  ArioClient,
  AntClient,
  ArnsDeployConfig,
} from './arns-deploy.js';

const MANIFEST_TX = 'M'.repeat(43); // valid 43-char base64url stub
const OTHER_TX = 'N'.repeat(43);

function makeConfig(overrides: Partial<ArnsDeployConfig> = {}): ArnsDeployConfig {
  return {
    name: 'toon-rig',
    type: 'lease',
    years: 1,
    ttlSeconds: DEFAULT_ARNS_TTL_SECONDS,
    gateway: DEFAULT_ARNS_GATEWAY,
    relay: 'wss://relay-ws.devnet.toonprotocol.dev',
    ...overrides,
  };
}

/** A mock ARIO registry client — records calls, spends nothing. */
function mockArio(overrides: Partial<ArioClient> = {}): ArioClient {
  return {
    getTokenCost: vi.fn(async () => 5_000_000),
    buyRecord: vi.fn(async () => ({ id: 'buy-msg-id' })),
    ...overrides,
  };
}

/** A mock per-name ANT client — records calls, spends nothing. */
function mockAnt(overrides: Partial<AntClient> = {}): AntClient {
  return {
    setBaseNameRecord: vi.fn(async () => ({ id: 'set-msg-id' })),
    ...overrides,
  };
}

describe('isValidArnsName', () => {
  it('[P0] accepts lowercase alphanumeric + hyphen names', () => {
    expect(isValidArnsName('toon-rig')).toBe(true);
    expect(isValidArnsName('a')).toBe(true);
    expect(isValidArnsName('rig123')).toBe(true);
  });

  it('[P0] rejects uppercase, spaces, and illegal chars', () => {
    expect(isValidArnsName('Toon')).toBe(false);
    expect(isValidArnsName('toon rig')).toBe(false);
    expect(isValidArnsName('toon_rig')).toBe(false);
    expect(isValidArnsName('toon.rig')).toBe(false);
  });

  it('[P1] rejects leading/trailing/double hyphens and over-long names', () => {
    expect(isValidArnsName('-rig')).toBe(false);
    expect(isValidArnsName('rig-')).toBe(false);
    expect(isValidArnsName('toon--rig')).toBe(false);
    expect(isValidArnsName('a'.repeat(52))).toBe(false);
    expect(isValidArnsName('a'.repeat(51))).toBe(true);
  });
});

describe('readArnsConfig — opt-in guard', () => {
  it('[P0] returns null when RIG_ARNS_NAME is unset (deploy flow unchanged)', () => {
    expect(readArnsConfig({})).toBeNull();
    expect(readArnsConfig({ RIG_ARNS_NAME: '   ' })).toBeNull();
  });

  it('[P0] resolves a full lease config from env', () => {
    const cfg = readArnsConfig({
      RIG_ARNS_NAME: 'toon-rig',
      RIG_ARNS_TYPE: 'lease',
      RIG_ARNS_YEARS: '2',
      RIG_ARNS_TTL_SECONDS: '600',
      RIG_ARNS_GATEWAY: 'https://permagate.io',
      RIG_ARNS_RELAY: 'wss://relay.example',
      RIG_ARNS_PROCESS_ID: 'proc-123',
      RIG_ARNS_WALLET: 'org-deploy-wallet',
    });
    expect(cfg).toEqual({
      name: 'toon-rig',
      type: 'lease',
      years: 2,
      ttlSeconds: 600,
      gateway: 'https://permagate.io',
      relay: 'wss://relay.example',
      processId: 'proc-123',
      walletId: 'org-deploy-wallet',
    });
  });

  it('[P1] applies defaults (type lease/1yr, ttl, gateway) and falls back to VITE_DEFAULT_RELAY', () => {
    const cfg = readArnsConfig({
      RIG_ARNS_NAME: 'toon-rig',
      VITE_DEFAULT_RELAY: 'wss://fallback.example',
    });
    expect(cfg).toMatchObject({
      name: 'toon-rig',
      type: 'lease',
      years: 1,
      ttlSeconds: DEFAULT_ARNS_TTL_SECONDS,
      gateway: DEFAULT_ARNS_GATEWAY,
      relay: 'wss://fallback.example',
    });
    expect(cfg?.processId).toBeUndefined();
  });

  it('[P1] permabuy omits years', () => {
    const cfg = readArnsConfig({
      RIG_ARNS_NAME: 'toon-rig',
      RIG_ARNS_TYPE: 'permabuy',
      RIG_ARNS_RELAY: 'wss://relay.example',
    });
    expect(cfg?.type).toBe('permabuy');
    expect(cfg?.years).toBeUndefined();
  });

  it('[P1] throws on invalid name / type / years / gateway / relay', () => {
    expect(() =>
      readArnsConfig({ RIG_ARNS_NAME: 'BAD NAME', RIG_ARNS_RELAY: 'wss://r' }),
    ).toThrow(/not a valid ArNS name/);
    expect(() =>
      readArnsConfig({
        RIG_ARNS_NAME: 'toon-rig',
        RIG_ARNS_TYPE: 'rent',
        RIG_ARNS_RELAY: 'wss://r',
      }),
    ).toThrow(/must be 'lease' or 'permabuy'/);
    expect(() =>
      readArnsConfig({
        RIG_ARNS_NAME: 'toon-rig',
        RIG_ARNS_YEARS: '9',
        RIG_ARNS_RELAY: 'wss://r',
      }),
    ).toThrow(/must be an integer 1–5/);
    expect(() =>
      readArnsConfig({
        RIG_ARNS_NAME: 'toon-rig',
        RIG_ARNS_GATEWAY: 'not-a-url',
        RIG_ARNS_RELAY: 'wss://r',
      }),
    ).toThrow(/RIG_ARNS_GATEWAY/);
    expect(() =>
      readArnsConfig({ RIG_ARNS_NAME: 'toon-rig' }),
    ).toThrow(/no relay is set/);
    expect(() =>
      readArnsConfig({ RIG_ARNS_NAME: 'toon-rig', RIG_ARNS_RELAY: 'http://r' }),
    ).toThrow(/must be a ws:\/\/ or wss:\/\//);
  });
});

describe('quoteBuyName (read-only, no spend)', () => {
  it('[P0] quotes via getTokenCost intent Buy-Name and converts mARIO→ARIO', async () => {
    const ario = mockArio({ getTokenCost: vi.fn(async () => 2_500_000) });
    const quote = await quoteBuyName(ario, makeConfig());
    expect(ario.getTokenCost).toHaveBeenCalledWith({
      intent: 'Buy-Name',
      name: 'toon-rig',
      type: 'lease',
      years: 1,
    });
    expect(quote).toEqual({ mARIO: 2_500_000, ARIO: 2_500_000 / MARIO_PER_ARIO });
  });

  it('[P1] omits years for permabuy quotes', async () => {
    const ario = mockArio();
    await quoteBuyName(ario, makeConfig({ type: 'permabuy', years: undefined }));
    expect(ario.getTokenCost).toHaveBeenCalledWith({
      intent: 'Buy-Name',
      name: 'toon-rig',
      type: 'permabuy',
    });
  });

  it('[P2] throws on a nonsensical cost', async () => {
    const ario = mockArio({ getTokenCost: vi.fn(async () => -1) });
    await expect(quoteBuyName(ario, makeConfig())).rejects.toThrow(/invalid cost/);
  });
});

describe('buyName (mock-only; spends nothing real)', () => {
  it('[P0] calls buyRecord with lease params and returns the message id', async () => {
    const ario = mockArio();
    const result = await buyName(ario, makeConfig({ years: 3 }));
    expect(ario.buyRecord).toHaveBeenCalledWith({
      name: 'toon-rig',
      type: 'lease',
      years: 3,
    });
    expect(result).toEqual({ messageId: 'buy-msg-id' });
  });

  it('[P1] forwards a configured processId (devnet/testnet registry)', async () => {
    const ario = mockArio();
    await buyName(ario, makeConfig({ processId: 'devnet-proc' }));
    expect(ario.buyRecord).toHaveBeenCalledWith(
      expect.objectContaining({ processId: 'devnet-proc' }),
    );
  });

  it('[P1] permabuy omits years', async () => {
    const ario = mockArio();
    await buyName(ario, makeConfig({ type: 'permabuy', years: undefined }));
    expect(ario.buyRecord).toHaveBeenCalledWith({
      name: 'toon-rig',
      type: 'permabuy',
    });
  });

  it('[P2] throws if buyRecord returns no id', async () => {
    const ario = mockArio({ buyRecord: vi.fn(async () => ({ id: '' })) });
    await expect(buyName(ario, makeConfig())).rejects.toThrow(/did not return a message id/);
  });
});

describe('pointNameAtManifest (mock-only)', () => {
  it('[P0] calls setBaseNameRecord with the manifest txId + ttl', async () => {
    const ant = mockAnt();
    const result = await pointNameAtManifest(ant, MANIFEST_TX, 900);
    expect(ant.setBaseNameRecord).toHaveBeenCalledWith({
      transactionId: MANIFEST_TX,
      ttlSeconds: 900,
    });
    expect(result).toEqual({ id: 'set-msg-id' });
  });

  it('[P0] rejects an invalid manifest txId (never calls the client)', async () => {
    const ant = mockAnt();
    await expect(pointNameAtManifest(ant, 'too-short', 900)).rejects.toThrow(
      /not a valid 43-char Arweave tx id/,
    );
    expect(ant.setBaseNameRecord).not.toHaveBeenCalled();
  });

  it('[P1] rejects a non-positive ttl', async () => {
    const ant = mockAnt();
    await expect(pointNameAtManifest(ant, MANIFEST_TX, 0)).rejects.toThrow(
      /ttlSeconds must be a positive integer/,
    );
    expect(ant.setBaseNameRecord).not.toHaveBeenCalled();
  });
});

describe('buildArnsUrl', () => {
  it('[P0] builds https://<name>.<gateway-host>/#relay=<relay>', () => {
    expect(buildArnsUrl(makeConfig())).toBe(
      'https://toon-rig.ar-io.dev/#relay=wss://relay-ws.devnet.toonprotocol.dev',
    );
  });

  it('[P1] is gateway-agnostic (uses only the host of the configured gateway)', () => {
    const url = buildArnsUrl(
      makeConfig({ gateway: 'https://permagate.io', relay: 'wss://r.example' }),
    );
    expect(url).toBe('https://toon-rig.permagate.io/#relay=wss://r.example');
  });
});

describe('runArnsRedeployStep — guarded/opt-in wiring', () => {
  it('[P0] is a no-op when no ArNS name is configured', async () => {
    const ant = mockAnt();
    const result = await runArnsRedeployStep({
      manifestTxId: MANIFEST_TX,
      ant,
      env: {}, // no RIG_ARNS_NAME
    });
    expect(result).toEqual({ skipped: true, reason: 'no ArNS name configured' });
    expect(ant.setBaseNameRecord).not.toHaveBeenCalled();
  });

  it('[P0] points the name and returns the stable URL when configured (via env)', async () => {
    const ant = mockAnt();
    const result = await runArnsRedeployStep({
      manifestTxId: MANIFEST_TX,
      ant,
      env: {
        RIG_ARNS_NAME: 'toon-rig',
        RIG_ARNS_RELAY: 'wss://relay.example',
        RIG_ARNS_TTL_SECONDS: '120',
      },
    });
    expect(ant.setBaseNameRecord).toHaveBeenCalledWith({
      transactionId: MANIFEST_TX,
      ttlSeconds: 120,
    });
    expect(result).toEqual({
      skipped: false,
      url: 'https://toon-rig.ar-io.dev/#relay=wss://relay.example',
      writeId: 'set-msg-id',
      name: 'toon-rig',
    });
  });

  it('[P1] accepts a pre-resolved config and skips when it is explicitly null', async () => {
    const ant = mockAnt();
    const skipped = await runArnsRedeployStep({
      manifestTxId: MANIFEST_TX,
      ant,
      config: null,
    });
    expect(skipped).toEqual({ skipped: true, reason: 'no ArNS name configured' });

    const done = await runArnsRedeployStep({
      manifestTxId: OTHER_TX,
      ant,
      config: makeConfig({ ttlSeconds: 300 }),
    });
    expect(ant.setBaseNameRecord).toHaveBeenCalledWith({
      transactionId: OTHER_TX,
      ttlSeconds: 300,
    });
    expect(done).toMatchObject({ skipped: false, name: 'toon-rig' });
  });

  it('[P1] propagates an invalid-manifest error without pointing the name', async () => {
    const ant = mockAnt();
    await expect(
      runArnsRedeployStep({
        manifestTxId: 'nope',
        ant,
        config: makeConfig(),
      }),
    ).rejects.toThrow(/not a valid 43-char Arweave tx id/);
    expect(ant.setBaseNameRecord).not.toHaveBeenCalled();
  });
});
