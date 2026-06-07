/**
 * Mina payment-channel primitives — connector-parity.
 *
 * Pure, dependency-light helpers that reproduce the EXACT off-chain
 * balance-proof contract the connector's `MinaPaymentChannelSDK`
 * (`@toon-protocol/connector` `settlement/mina-payment-channel-sdk.ts`)
 * implements, so a client-issued Mina payment-channel claim is structurally
 * accepted by connector 3.9.0's `validateMinaClaim` PREPARE gate and (once the
 * connector's proof-encoding bug is fixed, see below) verified by its
 * `verifyMinaClaim` / `verifyBalanceProof` settlement path.
 *
 * ## The connector's payment-channel scheme (authoritative, from 3.9.0 dist)
 *
 * `MinaPaymentChannelSDK.signBalanceProof(channel, balA, balB, salt, nonce)`:
 *
 *   commitment        = Poseidon.hash([Field(balA), Field(balB), Field(salt)])
 *   channelHashField  = Poseidon.hash([PublicKey.fromBase58(zkAppAddress).x])
 *   message           = [commitment, Field(nonce), channelHashField]
 *   signature         = Signature.create(privKey, message)   // Schnorr, Pallas
 *   proof (string)    = JSON.stringify({
 *                         commitment: commitment.toString(),
 *                         signature: { r, s },                // o1js JSON form
 *                         nonce: nonce.toString(),
 *                       })
 *
 * `MinaPaymentChannelSDK.verifyBalanceProof(channel, balanceCommitment, proof, nonce)`
 * re-derives `channelHashField` from `channel`, parses `proof` as the JSON above,
 * checks `proof.commitment === balanceCommitment` and `BigInt(proof.nonce) === nonce`,
 * then `Signature.fromJSON({r,s}).verify(signerPubKey, [commitment, Field(nonce),
 * channelHashField])`. The signer prefix is HARDCODED to `'devnet'` inside o1js
 * `Signature.create` / `.verify`, so the off-chain signature MUST be produced
 * with the Mina `'devnet'` network id (NOT `'mainnet'`).
 *
 * This is DISTINCT from the Mill ↔ sender swap-claim wire contract
 * (`balanceProofFieldsMina` in `@toon-protocol/core` — a Schnorr signature over
 * `[minaHashToField(channelId), amount, nonce, minaHashToField(recipient)]`).
 * That format is unchanged; this module is the separate payment-channel path
 * (mirrors the Solana #105 precedent: a payment-channel-specific message
 * distinct from the swap-format hash).
 *
 * ## Why mina-signer (not o1js)
 *
 * Poseidon, the Pallas Schnorr signature, the base58 signature codec and the
 * Pallas `PublicKey` field decode are all shipped INSIDE `mina-signer` (the same
 * implementations o1js re-exports). We reach them via a file-URL deep import off
 * the resolved `mina-signer` package root, so the client reproduces the
 * connector's scheme byte-for-byte WITHOUT pulling the multi-hundred-MB o1js
 * WASM circuit runtime. `mina-signer` is an OPTIONAL dependency.
 *
 * ## ⚠️ Connector 3.9.0 proof-encoding bug (documented, NOT worked around here)
 *
 * `validateMinaClaim` requires `claim.proof` to match `/^[A-Za-z0-9+/]+=*$/`
 * (base64), but `verifyBalanceProof` (and the connector's OWN claim producer
 * `per-packet-claim-service`) treat `proof` as RAW JSON (`JSON.parse(proof)` with
 * no base64 decode — and the connector emits the raw `JSON.stringify(...)` above).
 * Raw JSON fails the base64 regex, so a raw-JSON proof is REJECTED at the PREPARE
 * gate (no FULFILL). To pass the PREPARE gate (the FULFILL-deciding path) the
 * client MUST base64-encode the proof JSON. The connector's settlement-side
 * `JSON.parse` then fails on the base64 string — but that is post-FULFILL and is
 * the connector's own inconsistency (its producer and consumer disagree with its
 * validator). For non-EVM dynamic hidden-service peers settlement is gated by
 * connector#88 (`No chain configured for peer`) regardless, so this is a
 * documented connector follow-up, not a client defect. See
 * {@link buildMinaPaymentChannelProof} `proofEncoding`.
 *
 * @module
 */

/** Result of building a connector-parity Mina payment-channel proof. */
export interface MinaPaymentChannelProof {
  /** `Poseidon([balanceA, balanceB, salt]).toString()` — the claim's `balanceCommitment`. */
  balanceCommitment: string;
  /**
   * The claim's `proof` field: base64-encoded JSON
   * `{ commitment, signature: { r, s }, nonce, signerPublicKey }`. Base64 is
   * REQUIRED to pass connector 3.9.0 `validateMinaClaim` (see module note).
   */
  proof: string;
  /** Decimal salt string — the claim's `salt` field. */
  salt: string;
  /** Base58 signer public key — echoed for convenience. */
  signerPublicKey: string;
}

interface MinaSignerClientLike {
  signFields(fields: bigint[], privateKey: string): { signature: string };
  derivePublicKey(privateKey: string): string;
}
type MinaSignerClientCtor = new (opts: {
  network: string;
}) => MinaSignerClientLike;

interface PoseidonLike {
  hash(input: bigint[]): bigint;
}
interface SignatureCodecLike {
  fromBase58(base58: string): { r: bigint; s: bigint };
}
interface PublicKeyCodecLike {
  fromBase58(base58: string): { x: bigint; y: bigint };
}

interface MinaCryptoBindings {
  Client: MinaSignerClientCtor;
  Poseidon: PoseidonLike;
  Signature: SignatureCodecLike;
  PublicKey: PublicKeyCodecLike;
}

let cachedBindings: MinaCryptoBindings | null = null;

/**
 * Resolve the `mina-signer` package and load both its public `Client` and the
 * internal Poseidon / Signature / PublicKey codecs via file-URL deep import.
 *
 * `mina-signer`'s `package.json` `exports` map does NOT expose its
 * `bindings/crypto/poseidon.js` or `mina-signer/src/{signature,curve-bigint}.js`
 * subpaths, so a bare-specifier deep import (`import('mina-signer/.../poseidon.js')`)
 * is blocked (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Node only applies the exports
 * gate to bare specifiers, NOT to `file://` URLs — so we resolve the main entry
 * to a URL and navigate to the sibling internal files. These are the same
 * implementations o1js ships; reaching them here gives byte-for-byte parity with
 * the connector's o1js verify without the o1js WASM runtime.
 */
export async function loadMinaPaymentChannelBindings(): Promise<MinaCryptoBindings> {
  if (cachedBindings) return cachedBindings;

  const specifier = 'mina-signer';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib: any = await import(/* @vite-ignore */ specifier);
  const Client: MinaSignerClientCtor = 'default' in lib ? lib.default : lib;

  // Resolve the main entry to a file URL, then navigate to the internal modules.
  // mina-signer main: <root>/dist/node/mina-signer/mina-signer.js
  const mainUrl = import.meta.resolve(specifier);
  const minaSignerDir = new URL('./', mainUrl); // .../dist/node/mina-signer/
  const poseidonUrl = new URL('../bindings/crypto/poseidon.js', minaSignerDir)
    .href;
  const signatureUrl = new URL('./src/signature.js', minaSignerDir).href;
  const curveUrl = new URL('./src/curve-bigint.js', minaSignerDir).href;

  const [poseidonMod, signatureMod, curveMod] = await Promise.all([
    import(/* @vite-ignore */ poseidonUrl),
    import(/* @vite-ignore */ signatureUrl),
    import(/* @vite-ignore */ curveUrl),
  ]);

  cachedBindings = {
    Client,
    Poseidon: poseidonMod.Poseidon as PoseidonLike,
    Signature: signatureMod.Signature as SignatureCodecLike,
    PublicKey: curveMod.PublicKey as PublicKeyCodecLike,
  };
  return cachedBindings;
}

/** Reset the cached bindings (test hook). */
export function _resetMinaBindingsCache(): void {
  cachedBindings = null;
}

/**
 * Compute the connector's Mina balance commitment:
 *   `Poseidon.hash([Field(balanceA), Field(balanceB), Field(salt)])`.
 */
export function minaBalanceCommitment(
  poseidon: PoseidonLike,
  balanceA: bigint,
  balanceB: bigint,
  salt: bigint
): bigint {
  return poseidon.hash([balanceA, balanceB, salt]);
}

/**
 * Compute the connector's LEGACY channel-hash field, bound into the signed
 * message: `Poseidon.hash([PublicKey.fromBase58(zkAppAddress).x])`.
 *
 * This is the off-chain-only form. The connector's `verifyBalanceProof` accepts
 * a signature over EITHER this OR the participant form (see
 * {@link minaParticipantChannelHashField}), but the on-chain
 * `PaymentChannel.claimFromChannel` only accepts the PARTICIPANT form — so for a
 * claim that must SETTLE on-chain, sign the participant form instead.
 */
export function minaChannelHashField(
  poseidon: PoseidonLike,
  publicKeyCodec: PublicKeyCodecLike,
  zkAppAddress: string
): bigint {
  const zkAppPubKey = publicKeyCodec.fromBase58(zkAppAddress);
  return poseidon.hash([zkAppPubKey.x]);
}

/**
 * Compute the ON-CHAIN channel-hash field the zkApp stores and verifies:
 *   `Poseidon.hash([participantA.x, participantB.x, channelNonce])`.
 *
 * This MUST byte-for-byte reproduce what `PaymentChannel.initializeChannel`
 * wrote (`Poseidon([participantA.x, participantB.x, nonce])`, see
 * `packages/mina-zkapp/src/PaymentChannel.ts`) so that:
 *   1. the on-chain `claimFromChannel` signature check
 *      (`signatureA.verify(participantA, [commitment, nonce, storedChannelHash])`)
 *      passes, and
 *   2. the connector's off-chain `verifyBalanceProof` accepts it via its
 *      on-chain-channelHash message branch.
 *
 * Participant ORDER must match how the channel was opened. The client opens with
 * `participantA = client (payer)`, `participantB = apex (peer)`
 * (`OnChainChannelClient.openMinaChannel` → `openMinaChannelOnChain`), so the
 * client signs `Poseidon([client.x, apex.x, 0])`. The connector tries both
 * orderings when reconstructing, so it resolves the matching one regardless.
 */
export function minaParticipantChannelHashField(
  poseidon: PoseidonLike,
  publicKeyCodec: PublicKeyCodecLike,
  participantA_B62: string,
  participantB_B62: string,
  channelNonce: bigint
): bigint {
  const a = publicKeyCodec.fromBase58(participantA_B62);
  const b = publicKeyCodec.fromBase58(participantB_B62);
  return poseidon.hash([a.x, b.x, channelNonce]);
}

/**
 * Build a connector-parity Mina payment-channel balance proof.
 *
 * Reproduces `MinaPaymentChannelSDK.signBalanceProof` exactly: computes the
 * Poseidon balance commitment, the Poseidon channel-hash field, signs the
 * `[commitment, Field(nonce), channelHashField]` Pallas Schnorr message with the
 * `'devnet'` network id (matching o1js's hardcoded prefix), decodes the base58
 * signature to `{ r, s }` (o1js JSON form), and serializes
 * `{ commitment, signature: { r, s }, nonce, signerPublicKey }`.
 *
 * @param params.zkAppAddress  Deployed payment-channel zkApp B62 address — the
 *   claim's `zkAppAddress` AND the channel-hash preimage. MUST be the SAME
 *   address the apex's Mina provider resolves on-chain.
 * @param params.minaPrivateKeyBase58  Signer's Mina `EK…` base58 private key.
 * @param params.balanceA  Cumulative amount credited to the recipient (apex).
 * @param params.balanceB  Counterparty balance (0 for the unidirectional
 *   recipient-credit direction; `balanceB`/`signatureB` are OPTIONAL at
 *   connector validation, so single-party suffices).
 * @param params.salt  Commitment salt (bigint).
 * @param params.nonce  Monotonic claim nonce.
 * @param params.proofEncoding  `'base64'` (default) base64-encodes the proof JSON
 *   so it passes connector 3.9.0 `validateMinaClaim`'s base64 regex (REQUIRED for
 *   FULFILL). `'json'` emits the raw JSON the connector's `verifyBalanceProof`
 *   actually parses (rejected at the PREPARE gate today; provided for forward
 *   compatibility / tests once the connector's regex is fixed). See module note.
 */
export async function buildMinaPaymentChannelProof(params: {
  zkAppAddress: string;
  minaPrivateKeyBase58: string;
  signerPublicKey?: string;
  balanceA: bigint;
  balanceB: bigint;
  salt: bigint;
  nonce: bigint;
  proofEncoding?: 'base64' | 'json';
  /**
   * Participant pubkeys (B62) of the on-chain channel. When BOTH are supplied,
   * the proof is signed over the ON-CHAIN participant-form channelHash
   * (`Poseidon([participantA.x, participantB.x, channelNonce])`) instead of the
   * legacy zkApp-x form, so the resulting claim can settle on-chain via the
   * zkApp's `claimFromChannel` (which only verifies the participant form). The
   * order MUST match how the channel was opened (participantA = client/payer,
   * participantB = apex/peer). The connector accepts EITHER form off-chain, so
   * this is strictly an enabler for the on-chain settle path.
   */
  participantA?: string;
  participantB?: string;
  /** Channel nonce baked into the on-chain channelHash (default 0). */
  channelNonce?: bigint;
}): Promise<MinaPaymentChannelProof> {
  const { Client, Poseidon, Signature, PublicKey } =
    await loadMinaPaymentChannelBindings();

  // o1js `Signature.create`/`.verify` hardcode the 'devnet' prefix; the off-chain
  // signature must be produced with the matching mina-signer network id.
  const client = new Client({ network: 'devnet' });
  const signerPublicKey =
    params.signerPublicKey ??
    client.derivePublicKey(params.minaPrivateKeyBase58);

  const commitment = minaBalanceCommitment(
    Poseidon,
    params.balanceA,
    params.balanceB,
    params.salt
  );
  // Sign over the on-chain participant-form channelHash when both participants
  // are known (enables on-chain settle); otherwise fall back to the legacy
  // zkApp-x form (off-chain-store-only). Both are accepted by the connector's
  // verifyBalanceProof.
  const channelHashField =
    params.participantA && params.participantB
      ? minaParticipantChannelHashField(
          Poseidon,
          PublicKey,
          params.participantA,
          params.participantB,
          params.channelNonce ?? 0n
        )
      : minaChannelHashField(Poseidon, PublicKey, params.zkAppAddress);

  const message = [commitment, params.nonce, channelHashField];
  const signed = client.signFields(message, params.minaPrivateKeyBase58);
  // mina-signer `signFields` emits a base58 signature string; the connector
  // expects the o1js JSON `{ r, s }` decimal form, reachable by decoding the
  // base58 sig with the shared Pallas codec.
  const { r, s } = Signature.fromBase58(signed.signature);

  const proofObject = {
    commitment: commitment.toString(),
    signature: { r: r.toString(), s: s.toString() },
    nonce: params.nonce.toString(),
    signerPublicKey,
  };
  const proofJson = JSON.stringify(proofObject);
  const encoding = params.proofEncoding ?? 'base64';
  const proof =
    encoding === 'base64'
      ? Buffer.from(proofJson, 'utf8').toString('base64')
      : proofJson;

  return {
    balanceCommitment: commitment.toString(),
    proof,
    salt: params.salt.toString(),
    signerPublicKey,
  };
}
