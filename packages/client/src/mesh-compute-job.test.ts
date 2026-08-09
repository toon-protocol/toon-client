/**
 * End-to-end round trip for sealing at a client destination (toon-client#537,
 * toon-meta#266 §7): seal → serve → fulfil → verify → decrypt, with the buyer
 * holding only what a `kind:31990` advertisement would carry — the seller's
 * ADR 0018 sealing key ({@link ToonClient.getSealingPublicKey}) and ILP
 * address — never an announce lookup, and never a connector in the middle
 * deriving the fulfilment (which is why `sealExchange`'s ADR 0019 condition
 * derivation is absent here: the condition comes from the seller's own
 * hashlock offer, exactly as toon-meta#266 §7 specifies).
 *
 * This is the seam #537 exists to close, exercised as one story rather than
 * as its separate unit tests: `ToonClient.getSealingPublicKey()`,
 * `wire/giftwrap.ts`'s `sealRequest`/`openResponse`, `serve-job.ts`'s
 * sealed `createJobMessageHandler`, and `hashlock-delivery.ts`'s
 * `encryptArtifact`/`fulfillIncrement`/`decryptArtifact` — unchanged by this
 * ticket and reused as-is, per its own instruction not to define a second
 * condition/preimage relationship.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { generateSecretKey } from 'nostr-tools/pure';
import { ToonClient } from './ToonClient.js';
import { createJobMessageHandler, type JobAnswer, type JobRequest } from './serve-job.js';
import { openResponse, sealRequest } from './wire/giftwrap.js';
import {
  encryptArtifact,
  fulfillIncrement,
  decryptArtifact,
} from './hashlock-delivery.js';
import {
  ILPPacketType,
  serializeIlpPrepare,
  deserializeIlpPacket,
} from './btp/protocol.js';
import type { InboundBtpMessage } from './btp/IsomorphicBtpClient.js';
import { encodeUtf8, decodeUtf8 } from './utils/binary.js';
import type { ToonClientConfig } from './types.js';

// This client never encodes or decodes a Nostr event here — the job rides the
// ILP `data` field, not the TOON codec — but `ToonClientConfig` requires both.
const noopEncoder = (_event: NostrEvent): Uint8Array => new Uint8Array();
const noopDecoder = (_bytes: Uint8Array): NostrEvent => ({}) as NostrEvent;

function sellerConfig(secretKey: Uint8Array): ToonClientConfig {
  return {
    connectorUrl: 'http://localhost:8080',
    secretKey,
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.seller',
      btpEndpoint: 'ws://localhost:3000',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: noopEncoder,
    toonDecoder: noopDecoder,
  };
}

describe('mesh-compute job round trip (toon-client#537)', () => {
  it('seals, serves, fulfils, verifies and decrypts using only the advertised seal_pubkey', async () => {
    // The seller's identity — what a kind:31990 advertisement's `seal_pubkey`
    // tag would publish. The buyer below never resolves this any other way.
    const sellerSecretKey = generateSecretKey();
    const seller = new ToonClient(sellerConfig(sellerSecretKey));
    const advertisedSealPubkey = seller.getSealingPublicKey();

    // Seller (§7 step 1-2): already produced the completion and posted a
    // kind:7000 completed-offer before any PREPARE exists — the buyer reads
    // `condition` off that event, never re-derives it.
    const completion = encodeUtf8('the answer is 42');
    const offer = encryptArtifact(completion);

    // Buyer (§7 step 3): seals the job payload to the advertised key — no
    // announce lookup, no GET /identity — and pins executionCondition to the
    // offer's condition, byte for byte.
    const requestPayload = encodeUtf8(JSON.stringify({ prompt: 'what is 6*7?' }));
    const { wrapped, sharedSecret } = sealRequest(requestPayload, advertisedSealPubkey);

    const ilpPacket = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 1_000n,
      destination: 'g.toon.seller',
      executionCondition: offer.condition,
      expiresAt: new Date(Date.now() + 60_000),
      data: wrapped,
    });
    const inbound: InboundBtpMessage = { requestId: 1, protocolData: [], ilpPacket };

    // Seller (§7 step 5-6): unseal with its own identity, run the handler,
    // reveal the SAME key it minted the offer with as the fulfilment — never
    // a value derived from the ADR 0018 shared secret.
    let seenByHandler: JobRequest | undefined;
    const handler = (job: JobRequest): JobAnswer => {
      seenByHandler = job;
      return {
        fulfillment: fulfillIncrement(offer.key),
        data: encodeUtf8(JSON.stringify({ accepted: true })),
      };
    };
    const onMessage = createJobMessageHandler(handler, sellerSecretKey);
    const response = await onMessage(inbound);

    expect(JSON.parse(decodeUtf8(seenByHandler!.data))).toEqual({
      prompt: 'what is 6*7?',
    });

    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.FULFILL) throw new Error('expected FULFILL');

    // Buyer (§7 step 7-8): verify the fulfilment against ITS OWN
    // executionCondition, open the sealed FULFILL data with the shared
    // secret it kept from sealing, then decrypt the completion — the buyer
    // never re-derives `paidCondition` from what the seller just revealed.
    expect(decoded.fulfillment).toEqual(offer.key);
    expect(JSON.parse(decodeUtf8(openResponse(sharedSecret, decoded.data)))).toEqual(
      { accepted: true }
    );
    expect(
      decryptArtifact(offer.ciphertext, decoded.fulfillment, offer.condition)
    ).toEqual(completion);
  });
});
