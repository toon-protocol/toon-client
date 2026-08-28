import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfig,
  addressFor,
  DEFAULT_DEPOSIT,
  DEFAULT_SETTLEMENT_TIMEOUT,
  DEFAULT_TIMEOUT_MS,
} from './config.js';
import { ConfigError } from './errors.js';
import { InMemoryChannelStore, JsonFileChannelStore } from '../channel/ChannelStore.js';
import { deriveFullIdentity } from '../keys/KeyDerivation.js';
import { DEVNET } from '../presets.js';

const MNEMONIC =
  'test test test test test test test test test test test junk';
const CONNECTOR = 'https://proxy.ario.devnet.toonprotocol.dev';

/** A config that resolves, so a test can vary exactly one thing. */
function base(overrides: Record<string, unknown> = {}) {
  return { connector: CONNECTOR, mnemonic: MNEMONIC, ...overrides } as Parameters<
    typeof resolveConfig
  >[0];
}

/** Silence the in-memory-store warning where a test is not about it. */
function quiet() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveConfig — the connector', () => {
  it('normalises a trailing /ilp away, so both spellings name one edge', () => {
    quiet();
    expect(resolveConfig(base({ connector: `${CONNECTOR}/ilp` })).connector).toBe(CONNECTOR);
    expect(resolveConfig(base({ connector: `${CONNECTOR}/` })).connector).toBe(CONNECTOR);
  });

  it('is required — there is no default node to pay', () => {
    expect(() => resolveConfig(base({ connector: undefined }))).toThrow(ConfigError);
    expect(() => resolveConfig(base({ connector: '   ' }))).toThrow(ConfigError);
  });

  it('must be http(s): a client edge is fetched, not dialled', () => {
    expect(() => resolveConfig(base({ connector: 'ws://node.example' }))).toThrow(
      /http\(s\) URL/
    );
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => resolveConfig(base({ connector: 'proxy.example' }))).toThrow(ConfigError);
  });
});

describe('resolveConfig — keys', () => {
  it('derives both chains from one phrase', () => {
    quiet();
    const resolved = resolveConfig(base());
    expect(resolved.identity.evm?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(resolved.identity.solana?.publicKey).toBeTruthy();
    expect(resolved.identity.solana?.secretKey).toHaveLength(64);
  });

  it('honours the derivation scheme, so a pre-1.0 keystore keeps its addresses', () => {
    quiet();
    const standard = resolveConfig(base({ keyDerivation: 'standard' }));
    const legacy = resolveConfig(base({ keyDerivation: 'legacy' }));
    expect(standard.identity.evm?.address).not.toBe(legacy.identity.evm?.address);
    expect(standard.identity.evm?.address).toBe(
      deriveFullIdentity(MNEMONIC, { scheme: 'standard' }).evm.address
    );
    expect(legacy.identity.evm?.address).toBe(
      deriveFullIdentity(MNEMONIC, { scheme: 'legacy' }).evm.address
    );
  });

  it('defaults to `standard` — BIP-44 as every wallet derives it', () => {
    quiet();
    expect(resolveConfig(base()).keyDerivation).toBe('standard');
  });

  it('walks the account index', () => {
    quiet();
    expect(resolveConfig(base({ accountIndex: 1 })).identity.evm?.address).not.toBe(
      resolveConfig(base()).identity.evm?.address
    );
  });

  it('lets a raw key win over the phrase for its own chain', () => {
    quiet();
    const raw = `0x${'11'.repeat(32)}`;
    const resolved = resolveConfig(base({ evmPrivateKey: raw }));
    expect(resolved.identity.evm?.address).not.toBe(
      deriveFullIdentity(MNEMONIC).evm.address
    );
    // …and leaves the other chain's derived key alone.
    expect(resolved.identity.solana?.publicKey).toBe(deriveFullIdentity(MNEMONIC).solana.publicKey);
  });

  it('accepts a 32-byte Solana seed and a 64-byte secret key alike', () => {
    quiet();
    const derived = deriveFullIdentity(MNEMONIC).solana;
    const fromSeed = resolveConfig(base({ solanaSecretKey: derived.secretKey.slice(0, 32) }));
    const fromFull = resolveConfig(base({ solanaSecretKey: derived.secretKey }));
    expect(fromSeed.identity.solana?.publicKey).toBe(derived.publicKey);
    expect(fromFull.identity.solana?.publicKey).toBe(derived.publicKey);
  });

  it('refuses key material of the wrong length rather than signing with it', () => {
    expect(() => resolveConfig(base({ evmPrivateKey: new Uint8Array(16) }))).toThrow(
      /32 bytes/
    );
    expect(() => resolveConfig(base({ solanaSecretKey: new Uint8Array(48) }))).toThrow(
      /32-byte seed or a 64-byte/
    );
    expect(() => resolveConfig(base({ evmPrivateKey: 'not hex' }))).toThrow(/hex/);
  });

  it('refuses a phrase that fails its own checksum', () => {
    expect(() =>
      resolveConfig(base({ mnemonic: 'abandon abandon abandon abandon' }))
    ).toThrow(/BIP-39/);
  });

  it('refuses a client with no key at all — there is no unauthenticated way to pay', () => {
    expect(() => resolveConfig({ connector: CONNECTOR })).toThrow(/No key material/);
  });
});

describe('resolveConfig — the chain preference', () => {
  it('is left unset by default, so the node\'s own settlements decide', () => {
    quiet();
    expect(resolveConfig(base()).chain).toBeUndefined();
  });

  it('refuses a chain this client holds no key for, before any network call', () => {
    expect(() =>
      resolveConfig({ connector: CONNECTOR, evmPrivateKey: `0x${'11'.repeat(32)}`, chain: 'solana' })
    ).toThrow(/holds no solana key/);
  });

  it('refuses a chain that is not a chain', () => {
    expect(() => resolveConfig(base({ chain: 'mina' }))).toThrow(/'evm' or 'solana'/);
  });
});

describe('resolveConfig — defaults', () => {
  it('fills the documented ones', () => {
    quiet();
    const resolved = resolveConfig(base());
    expect(resolved.deposit).toBe(DEFAULT_DEPOSIT);
    expect(resolved.settlementTimeout).toBe(DEFAULT_SETTLEMENT_TIMEOUT);
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolved.transport).toBe('auto');
    expect(resolved.autoOpenChannel).toBe(true);
    expect(resolved.btp.declareChannel).toBe(true);
    expect(resolved.faucetUrl).toBe(DEVNET.faucet);
    expect(resolved.senderId).toBeUndefined();
  });

  it('resolves an RPC per chain from the presets when none is configured', () => {
    quiet();
    const resolved = resolveConfig(base());
    expect(resolved.rpcUrls.evm).toBe(DEVNET.evm.rpcUrl);
    expect(resolved.rpcUrls.solana).toBe(DEVNET.solana.rpcUrl);
  });

  it('lets an explicit rpcUrl override', () => {
    quiet();
    const resolved = resolveConfig(base({ rpcUrl: 'https://rpc.example' }));
    expect(resolved.rpcUrls.evm).toBe('https://rpc.example');
  });

  it('takes a deposit as a decimal string as well as a bigint', () => {
    quiet();
    expect(resolveConfig(base({ deposit: '250000' })).deposit).toBe(250_000n);
    expect(resolveConfig(base({ deposit: 7n })).deposit).toBe(7n);
  });

  it('refuses figures that cannot mean anything', () => {
    expect(() => resolveConfig(base({ deposit: -1n }))).toThrow(/negative/);
    expect(() => resolveConfig(base({ deposit: 'lots' }))).toThrow(ConfigError);
    expect(() => resolveConfig(base({ timeoutMs: 0 }))).toThrow(/positive/);
    expect(() => resolveConfig(base({ settlementTimeout: -5 }))).toThrow(/positive/);
    expect(() => resolveConfig(base({ accountIndex: -1 }))).toThrow(/non-negative/);
    expect(() => resolveConfig(base({ transport: 'carrier-pigeon' }))).toThrow(
      /'auto', 'http' or 'btp'/
    );
  });
});

describe('resolveConfig — the channel store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('takes a path as a JSON file store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toon-config-'));
    dirs.push(dir);
    const resolved = resolveConfig(base({ channelStore: join(dir, 'channels.json') }));
    expect(resolved.channelStore).toBeInstanceOf(JsonFileChannelStore);
    expect(resolved.channelStoreIsEphemeral).toBe(false);
  });

  it('takes a store object as given', () => {
    const store = new InMemoryChannelStore();
    const resolved = resolveConfig(base({ channelStore: store }));
    expect(resolved.channelStore).toBe(store);
    // A store the caller CHOSE is not the accident the warning is about.
    expect(resolved.channelStoreIsEphemeral).toBe(false);
  });

  it('WARNS when it falls back to memory — a lost watermark refuses every later claim', () => {
    const warn = quiet();
    const resolved = resolveConfig(base());
    expect(resolved.channelStore).toBeInstanceOf(InMemoryChannelStore);
    expect(resolved.channelStoreIsEphemeral).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('channelStore');
    // The warning has to say what goes wrong, not merely that something might.
    expect(message).toMatch(/nonces the connector has already banked/);
  });

  it('refuses an empty path rather than writing to the working directory', () => {
    expect(() => resolveConfig(base({ channelStore: '  ' }))).toThrow(ConfigError);
  });
});

describe('addressFor', () => {
  it('reads the address for a chain, or nothing when no key is held', () => {
    quiet();
    const { identity } = resolveConfig(base());
    expect(addressFor(identity, 'evm')).toBe(identity.evm?.address);
    expect(addressFor(identity, 'solana')).toBe(identity.solana?.publicKey);
    expect(addressFor({}, 'evm')).toBeUndefined();
  });
});
