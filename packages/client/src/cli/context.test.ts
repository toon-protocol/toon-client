import { describe, expect, it } from 'vitest';
import { UsageError, CliConfigError, parseCommandLine } from './args.js';
import {
  buildClientConfig,
  defaultChannelStorePath,
  resolveKeyMaterial,
  resolveSettings,
  type CliSettings,
} from './context.js';
import { DEVNET } from '../presets.js';

/** Parse a line the way `main` does, so precedence is tested through the real path. */
function settingsFor(argv: string[], env: Record<string, string | undefined> = {}) {
  return resolveSettings(parseCommandLine(argv).values, env, { home: '/home/x' });
}

describe('settings resolution', () => {
  it('takes the connector from the flag first', () => {
    const { settings } = settingsFor(['balances', '--connector', 'https://flag'], {
      TOON_CONNECTOR: 'https://env',
    });
    expect(settings.connector).toBe('https://flag');
    expect(settings.connectorSource).toBe('flag');
  });

  it('falls back to the environment', () => {
    const { settings } = settingsFor(['balances'], { TOON_CONNECTOR: 'https://env' });
    expect(settings.connector).toBe('https://env');
    expect(settings.connectorSource).toBe('env');
  });

  it('falls back to the devnet preset, and says so on stderr', () => {
    const { settings, warnings } = settingsFor(['balances'], {});
    expect(settings.connector).toBe(DEVNET.store.url);
    expect(settings.connectorSource).toBe('default');
    expect(warnings.join('\n')).toMatch(/no connector given/);
  });

  it('resolves chain, rpc and store the same way', () => {
    const env = {
      TOON_CHAIN: 'solana',
      TOON_RPC_URL: 'https://rpc.env',
      TOON_CHANNEL_STORE: '/env/channels.json',
    };
    expect(settingsFor(['balances'], env).settings).toMatchObject({
      chain: 'solana',
      rpcUrl: 'https://rpc.env',
      channelStore: '/env/channels.json',
    });
    const flags = settingsFor(
      ['balances', '--chain', 'evm', '--rpc', 'https://rpc.flag', '--store', '/flag.json'],
      env
    );
    expect(flags.settings).toMatchObject({
      chain: 'evm',
      rpcUrl: 'https://rpc.flag',
      channelStore: '/flag.json',
    });
  });

  it('defaults the channel store to a file, never to memory', () => {
    const { settings } = settingsFor(['balances'], {});
    expect(settings.channelStore).toBe(defaultChannelStorePath('/home/x'));
  });

  it('defaults the transport to auto and validates an explicit one', () => {
    expect(settingsFor(['balances'], {}).settings.transport).toBe('auto');
    expect(settingsFor(['balances', '--transport', 'btp'], {}).settings.transport).toBe('btp');
    expect(() => settingsFor(['balances', '--transport', 'carrier-pigeon'], {})).toThrow(
      UsageError
    );
  });

  it('refuses a chain it cannot settle on', () => {
    expect(() => settingsFor(['balances', '--chain', 'bitcoin'], {})).toThrow(UsageError);
  });
});

const BASE: CliSettings = {
  connector: 'https://node.example',
  connectorSource: 'flag',
  channelStore: '/tmp/channels.json',
  transport: 'auto',
  keystorePath: '/nowhere/keystore.json',
  json: false,
  quiet: false,
};

const PHRASE = 'test test test test test test test test test test test junk';

describe('key material', () => {
  it('takes TOON_MNEMONIC ahead of any keystore, as the standard derivation', async () => {
    const keys = await resolveKeyMaterial(BASE, { env: { TOON_MNEMONIC: ` ${PHRASE} ` }, home: '/home/x' });
    expect(keys).toEqual({
      kind: 'mnemonic',
      mnemonic: PHRASE,
      derivation: 'standard',
      from: 'env',
    });
  });

  it("tells a newcomer to run 'toon init' when there are no keys at all", async () => {
    const promise = resolveKeyMaterial(BASE, { env: {}, home: '/home/x' });
    await expect(promise).rejects.toThrow(CliConfigError);
    await expect(promise).rejects.toThrow(/no keys/);
  });

  it('hands the free commands a throwaway identity instead of failing', async () => {
    const keys = await resolveKeyMaterial(BASE, { env: {}, home: '/home/x' }, { keyless: true });
    expect(keys).toEqual({ kind: 'ephemeral' });
  });
});

describe('buildClientConfig', () => {
  it('never lets a command open a channel as a side effect', () => {
    const config = buildClientConfig(BASE, {
      kind: 'mnemonic',
      mnemonic: PHRASE,
      derivation: 'legacy',
      from: 'keystore',
    });
    expect(config.autoOpenChannel).toBe(false);
    expect(config).toMatchObject({
      connector: 'https://node.example',
      channelStore: '/tmp/channels.json',
      transport: 'auto',
      mnemonic: PHRASE,
      keyDerivation: 'legacy',
    });
  });

  it('gives an ephemeral run real keys, so the free reads still work', () => {
    const config = buildClientConfig(BASE, { kind: 'ephemeral' });
    expect(config.mnemonic).toBeUndefined();
    expect(config.evmPrivateKey).toBeInstanceOf(Uint8Array);
    expect(config.solanaSecretKey).toBeInstanceOf(Uint8Array);
  });

  it('omits chain and rpc when nothing chose them', () => {
    const config = buildClientConfig(BASE, { kind: 'ephemeral' });
    expect('chain' in config).toBe(false);
    expect('rpcUrl' in config).toBe(false);
  });
});
