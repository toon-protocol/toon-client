import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { type Hex, toHex } from 'viem';

/**
 * An EVM key, held as a viem account: what signs this client's vouchers,
 * challenges, deposit authorizations and on-chain transactions.
 *
 * Encapsulates the private key — no getPrivateKey() method is exposed. What it
 * signs is decided elsewhere (`../channel/batch-settlement/`); since connector
 * ADR 0075 there is no balance proof left for it to sign.
 */
export class EvmSigner {
  readonly chainType = 'evm' as const;
  private readonly _account: PrivateKeyAccount;

  /**
   * @param privateKey - EVM private key as hex string (with or without 0x prefix) or Uint8Array
   */
  constructor(privateKey: string | Uint8Array) {
    let hexKey: Hex;
    if (privateKey instanceof Uint8Array) {
      hexKey = toHex(privateKey);
    } else {
      hexKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
    }
    this._account = privateKeyToAccount(hexKey);
  }

  /** Derived 0x EVM address */
  get address(): string {
    return this._account.address;
  }

  /** Viem PrivateKeyAccount — usable with walletClient for on-chain transactions, and to sign typed data */
  get account(): PrivateKeyAccount {
    return this._account;
  }
}
