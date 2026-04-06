// Ambient module declaration for @noble/curves/ed25519.
// The client uses @noble/ed25519 as primary dep but imports from
// @noble/curves/ed25519 for SLIP-0010 derivation. This stub prevents
// DTS build failures when @noble/curves is not installed.
declare module '@noble/curves/ed25519' {
  export const ed25519: {
    getPublicKey(privateKey: Uint8Array): Uint8Array;
  };
}
