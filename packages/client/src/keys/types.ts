/**
 * What a mnemonic derives to.
 *
 * One phrase, two chains. Both keys come from the same BIP-39 seed, so a single
 * backed-up phrase recovers every channel this client can open — and each key
 * sits on its own coin type, so the EVM half can be imported into an ordinary
 * wallet to be inspected or topped up.
 */
export interface DerivedIdentity {
  evm: {
    /** 32-byte secp256k1 secret. */
    privateKey: Uint8Array;
    /** `0x`-prefixed, EIP-55 checksummed. */
    address: string;
  };
  solana: {
    /** 64-byte Ed25519 keypair (seed ‖ public). */
    secretKey: Uint8Array;
    /** Base58 public key. */
    publicKey: string;
  };
}
