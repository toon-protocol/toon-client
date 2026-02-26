import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import { type Hex, toHex } from 'viem';
import type { BalanceProofParams, SignedBalanceProof } from '../types.js';

/**
 * EVM claim message for BTP protocol data.
 * Matches @agent-society/connector's EVMClaimMessage interface.
 */
export interface EVMClaimMessage {
  blockchain: 'evm';
  senderId: string;
  channelId: string;
  nonce: number;
  transferredAmount: string;
  lockedAmount: string;
  locksRoot: string;
  signature: string;
  signerAddress: string;
}

/**
 * EIP-712 domain for TokenNetwork balance proofs.
 * Must match connector's eip712-helper.js getDomainSeparator().
 */
function getBalanceProofDomain(chainId: number, tokenNetworkAddress: string) {
  return {
    name: 'TokenNetwork' as const,
    version: '1' as const,
    chainId,
    verifyingContract: tokenNetworkAddress as Hex,
  };
}

/**
 * EIP-712 types for balance proofs.
 * Must match connector's eip712-helper.js getBalanceProofTypes().
 */
const BALANCE_PROOF_TYPES = {
  BalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'transferredAmount', type: 'uint256' },
    { name: 'lockedAmount', type: 'uint256' },
    { name: 'locksRoot', type: 'bytes32' },
  ],
} as const;

/**
 * EVM signer for EIP-712 balance proofs and on-chain transactions.
 *
 * Encapsulates the private key — no getPrivateKey() method is exposed.
 */
export class EvmSigner {
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

  /** Viem PrivateKeyAccount — usable with walletClient for on-chain transactions */
  get account(): PrivateKeyAccount {
    return this._account;
  }

  /**
   * Signs a balance proof using EIP-712 typed data.
   *
   * @param params - Balance proof parameters plus chain context
   * @returns Signed balance proof with signature
   */
  async signBalanceProof(
    params: BalanceProofParams & { chainId: number; tokenNetworkAddress: string }
  ): Promise<SignedBalanceProof> {
    const domain = getBalanceProofDomain(params.chainId, params.tokenNetworkAddress);

    const signature = await this._account.signTypedData({
      domain,
      types: BALANCE_PROOF_TYPES,
      primaryType: 'BalanceProof',
      message: {
        channelId: params.channelId as Hex,
        nonce: BigInt(params.nonce),
        transferredAmount: params.transferredAmount,
        lockedAmount: params.lockedAmount,
        locksRoot: params.locksRoot as Hex,
      },
    });

    return {
      channelId: params.channelId,
      nonce: params.nonce,
      transferredAmount: params.transferredAmount,
      lockedAmount: params.lockedAmount,
      locksRoot: params.locksRoot,
      signature,
      signerAddress: this._account.address,
    };
  }

  /**
   * Builds an EVMClaimMessage from a signed balance proof.
   * Static so it can be called without an EvmSigner instance.
   *
   * @param proof - Signed balance proof
   * @param senderId - Nostr pubkey or identifier of the sender
   * @returns EVMClaimMessage compatible with BTP_CLAIM_PROTOCOL
   */
  static buildClaimMessage(proof: SignedBalanceProof, senderId: string): EVMClaimMessage {
    return {
      blockchain: 'evm',
      senderId,
      channelId: proof.channelId,
      nonce: proof.nonce,
      transferredAmount: proof.transferredAmount.toString(),
      lockedAmount: proof.lockedAmount.toString(),
      locksRoot: proof.locksRoot,
      signature: proof.signature,
      signerAddress: proof.signerAddress,
    };
  }
}
