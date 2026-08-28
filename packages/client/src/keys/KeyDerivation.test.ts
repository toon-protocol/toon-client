/**
 * Key derivation, pinned against an oracle outside this repository.
 *
 * The mnemonic below is the one Foundry's `anvil` and Hardhat ship as their
 * default, and the addresses asserted for the `standard` scheme are the accounts
 * those tools print on startup. That makes this a genuine cross-check rather
 * than a snapshot of our own behaviour: if the standard path ever drifts, these
 * fail against a value produced by software we do not control — which is the
 * whole point of moving EVM onto BIP-44's registered coin type.
 *
 * The `legacy` vectors have no such oracle, and could not: they are this
 * client's own pre-1.0 path, sitting on Nostr's coin type because one key once
 * served both roles. They are pinned because real channels were funded at those
 * addresses, and a keystore written before 1.0 still derives them.
 */
import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  validateMnemonic,
  deriveFullIdentity,
  generateRandomIdentity,
  evmDerivationPath,
} from './KeyDerivation.js';

/** Foundry/Hardhat's default mnemonic. Never use it for anything that holds value. */
const ANVIL_MNEMONIC =
  'test test test test test test test test test test test junk';

/** `anvil` prints these as accounts (0) and (3). */
const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_ACCOUNT_3 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

describe('generateMnemonic', () => {
  it('produces a valid 12-word phrase', () => {
    const mnemonic = generateMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(12);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  it('produces a different phrase each time', () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic());
  });
});

describe('validateMnemonic', () => {
  it('accepts a correct phrase', () => {
    expect(validateMnemonic(ANVIL_MNEMONIC)).toBe(true);
  });

  it('rejects a phrase whose checksum does not hold', () => {
    expect(validateMnemonic('abandon '.repeat(11) + 'abandon')).toBe(false);
    expect(validateMnemonic('not even a mnemonic')).toBe(false);
  });
});

describe('evmDerivationPath', () => {
  it('puts the standard scheme on coin type 60 and the legacy one on 1237', () => {
    expect(evmDerivationPath('standard', 0)).toBe("m/44'/60'/0'/0/0");
    expect(evmDerivationPath('standard', 3)).toBe("m/44'/60'/0'/0/3");
    expect(evmDerivationPath('legacy', 0)).toBe("m/44'/1237'/0'/0/0");
    expect(evmDerivationPath('legacy', 3)).toBe("m/44'/1237'/0'/0/3");
  });
});

describe('deriveFullIdentity — standard scheme', () => {
  it('derives the same EVM account anvil and every wallet derive', () => {
    expect(deriveFullIdentity(ANVIL_MNEMONIC).evm.address).toBe(ANVIL_ACCOUNT_0);
    expect(
      deriveFullIdentity(ANVIL_MNEMONIC, { accountIndex: 3 }).evm.address
    ).toBe(ANVIL_ACCOUNT_3);
  });

  it('is the default — an unqualified call is the standard path', () => {
    expect(deriveFullIdentity(ANVIL_MNEMONIC).evm.address).toBe(
      deriveFullIdentity(ANVIL_MNEMONIC, { scheme: 'standard' }).evm.address
    );
  });

  it('derives a Solana keypair alongside it', () => {
    const identity = deriveFullIdentity(ANVIL_MNEMONIC);
    expect(identity.solana.secretKey).toHaveLength(64);
    expect(identity.solana.publicKey).toBe(
      'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96'
    );
  });
});

describe('deriveFullIdentity — legacy scheme', () => {
  it('still derives the pre-1.0 addresses, which hold real channels', () => {
    expect(deriveFullIdentity(ANVIL_MNEMONIC, { scheme: 'legacy' }).evm.address).toBe(
      '0xc9ab3656993E8d8a13dbbCf656d6D338eF6DeD3f'
    );
    expect(
      deriveFullIdentity(ANVIL_MNEMONIC, { scheme: 'legacy', accountIndex: 3 })
        .evm.address
    ).toBe('0xF56bf210275A88404Ff2aFC3f7C9F27648Ca543D');
  });

  it('differs from the standard scheme — which is why the scheme is recorded', () => {
    expect(deriveFullIdentity(ANVIL_MNEMONIC, { scheme: 'legacy' }).evm.address).not.toBe(
      deriveFullIdentity(ANVIL_MNEMONIC, { scheme: 'standard' }).evm.address
    );
  });

  it('leaves Solana untouched — only the EVM coin type moved', () => {
    expect(
      deriveFullIdentity(ANVIL_MNEMONIC, { scheme: 'legacy' }).solana.publicKey
    ).toBe(deriveFullIdentity(ANVIL_MNEMONIC).solana.publicKey);
  });
});

describe('deriveFullIdentity — general', () => {
  it('is deterministic', () => {
    const a = deriveFullIdentity(ANVIL_MNEMONIC);
    const b = deriveFullIdentity(ANVIL_MNEMONIC);
    expect(a.evm.address).toBe(b.evm.address);
    expect(a.evm.privateKey).toEqual(b.evm.privateKey);
    expect(a.solana.secretKey).toEqual(b.solana.secretKey);
  });

  it('gives different phrases different keys', () => {
    const other = generateMnemonic();
    expect(deriveFullIdentity(ANVIL_MNEMONIC).evm.address).not.toBe(
      deriveFullIdentity(other).evm.address
    );
  });

  it('accepts a bare account index, as it did before 1.0', () => {
    expect(deriveFullIdentity(ANVIL_MNEMONIC, 3).evm.address).toBe(
      ANVIL_ACCOUNT_3
    );
  });

  it('rejects an account index BIP-32 cannot represent', () => {
    expect(() => deriveFullIdentity(ANVIL_MNEMONIC, { accountIndex: -1 })).toThrow(
      /accountIndex/
    );
    expect(() =>
      deriveFullIdentity(ANVIL_MNEMONIC, { accountIndex: 2 ** 31 })
    ).toThrow(/accountIndex/);
    expect(() =>
      deriveFullIdentity(ANVIL_MNEMONIC, { accountIndex: 1.5 })
    ).toThrow(/accountIndex/);
  });
});

describe('generateRandomIdentity', () => {
  it('produces a usable identity on both chains', () => {
    const identity = generateRandomIdentity();
    expect(identity.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(identity.evm.privateKey).toHaveLength(32);
    expect(identity.solana.secretKey).toHaveLength(64);
    expect(identity.solana.publicKey.length).toBeGreaterThan(30);
  });

  it('produces a different identity each time', () => {
    expect(generateRandomIdentity().evm.address).not.toBe(
      generateRandomIdentity().evm.address
    );
  });
});
