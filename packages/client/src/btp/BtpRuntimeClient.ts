import {
  IsomorphicBtpClient,
  BtpConnectionError,
  type BtpChannelDeclaration,
  type BtpMessageHandler,
  type BtpTransferHandler,
} from '../btp/IsomorphicBtpClient.js';
import { type BTPProtocolData } from '../btp/protocol.js';
import type { IlpSendResult } from '../ilp/types.js';
import {
  ACCUMULATED_COST_PROTOCOL,
  CLAIM_ACK_PROTOCOL,
  PAYMENT_REQUIRED_PROTOCOL,
  buildResponseMeta,
  decodeAccumulatedCost,
  decodeClaimAck,
  decodePaymentRequired,
  type IlpResponseMeta,
} from '../ilp/response-meta.js';
import { NothingWritten } from '../carriage/nothing-written.js';
import { fromBase64, encodeUtf8, decodeUtf8 } from '../utils/binary.js';
import {
  mapIlpResponse,
  resolveExpectedFulfillment,
  resolveExpiresAt,
  type IlpSendParams,
} from '../ilp/ilp-send.js';
import { assertValidFulfillment } from '../utils/fulfillment.js';

export type { BtpChannelDeclaration };

export interface BtpRuntimeClientConfig {
  btpUrl: string;
  peerId: string;
  authToken: string;
  /** Custom WebSocket constructor (for testing / custom transports). */
  createWebSocket?: (url: string) => WebSocket;
  /**
   * Handles a server-originated MESSAGE (RFC-0023 symmetric grammar,
   * toon-client#493). Re-registered on every `connect()`/`reconnect()` since
   * each creates a fresh `IsomorphicBtpClient` for the new socket.
   */
  onMessage?: BtpMessageHandler;
  /** Handles a server-originated TRANSFER. Re-registered the same way as `onMessage`. */
  onTransfer?: BtpTransferHandler;
  /** Surfaces in-flight inbound work orphaned by a disconnect instead of silently vanishing. */
  onInboundError?: (error: Error, requestId: number) => void;
  /**
   * Called on every `connect()`/`reconnect()` and every explicit
   * {@link BtpRuntimeClient.reauthenticate} to fetch the caller's current
   * channel to declare on the greeting. Additive: unset (or an `undefined`
   * result) leaves the greeting unchanged (toon-client#513).
   */
  getChannelDeclaration?: () =>
    | Promise<BtpChannelDeclaration | undefined>
    | BtpChannelDeclaration
    | undefined;
}

/**
 * Read the three facts that ride BESIDE the answer packet off a RESPONSE
 * frame's protocolData entries — the BTP twin of `HttpIlpClient`'s
 * `readResponseMeta(headers)`.
 *
 * The two MUST produce identical values from the connector's paired vectors,
 * which is why both delegate to the one decoder each in
 * `../ilp/response-meta.js` rather than parsing here. The ONE thing that
 * differs between the carriages is the envelope, and only that: a websocket
 * frame has no headers, so BTP carries each value as raw UTF-8 in a
 * protocolData entry where HTTP base64s it into a header
 * (`client-edge-spec.md` §1.9 step 2 — "no base64 layer; that is an
 * HTTP-header artifact"). The entry names come from
 * `connector_btp::CARRIAGE_NAMES`, which declares each concept's BTP and HTTP
 * spellings as a pair; note `claim-ack` is the one whose two halves differ
 * (`claim-ack` here, `toon-claim-ack` there).
 *
 * Every field is independently optional. In particular `accumulatedCost` is
 * present on a REJECT and absent from a FULFILL (§1.6), while a `claim-ack` of
 * `rejected` can sit on a FULFILL — the packet's verdict and the claim's are
 * separate answers to separate questions and are never inferred from each
 * other.
 */
export function readResponseMeta(
  protocolData: BTPProtocolData[]
): IlpResponseMeta {
  const entry = (name: string): string | undefined => {
    const found = protocolData.find((pd) => pd.protocolName === name);
    return found ? decodeUtf8(found.data) : undefined;
  };

  const cost = entry(ACCUMULATED_COST_PROTOCOL);
  const ack = entry(CLAIM_ACK_PROTOCOL);
  const terms = entry(PAYMENT_REQUIRED_PROTOCOL);

  return buildResponseMeta({
    accumulatedCost: cost !== undefined ? decodeAccumulatedCost(cost) : undefined,
    claimAck: ack !== undefined ? decodeClaimAck(ack) : undefined,
    paymentRequired: terms !== undefined ? decodePaymentRequired(terms) : undefined,
  });
}

/**
 * BTP transport: the carriage's BTP session.
 * Uses IsomorphicBtpClient (browser-native, no Node.js dependencies).
 *
 * Each send is ONE attempt. It never retries: whether to try again is the
 * carriage's retry rule (ADR 0007), and the only fact this session hands it is
 * {@link NothingWritten} — thrown when connecting failed, or the socket was
 * not open, before any byte of the packet left.
 */
export class BtpRuntimeClient {
  private btpClient: IsomorphicBtpClient | null = null;
  private readonly config: BtpRuntimeClientConfig;

  constructor(config: BtpRuntimeClientConfig) {
    this.config = config;
  }

  /**
   * Connects to the BTP peer via WebSocket.
   */
  async connect(): Promise<void> {
    this.btpClient = new IsomorphicBtpClient({
      url: this.config.btpUrl,
      peerId: this.config.peerId,
      authToken: this.config.authToken,
      createWebSocket: this.config.createWebSocket,
      onMessage: this.config.onMessage,
      onTransfer: this.config.onTransfer,
      onInboundError: this.config.onInboundError,
      getChannelDeclaration: this.config.getChannelDeclaration,
    });

    await this.btpClient.connect();
  }

  /**
   * Re-sends the auth greeting on the EXISTING session — no reconnect — so a
   * channel that became known (or changed) after `connect()` is declared on
   * the live session (toon-client#513). A no-op when not connected; the next
   * `connect()`/`reconnect()` already re-declares via `getChannelDeclaration`.
   */
  async reauthenticate(): Promise<void> {
    if (!this.isConnected || !this.btpClient) return;
    await this.btpClient.reauthenticate();
  }

  /**
   * Attempts to reconnect by creating a fresh client and connecting.
   */
  async reconnect(): Promise<void> {
    if (this.btpClient) {
      try {
        await this.btpClient.disconnect();
      } catch {
        // Ignore disconnect errors during reconnect
      }
      this.btpClient = null;
    }

    await this.connect();
  }

  /**
   * Disconnects from the BTP peer.
   */
  async disconnect(): Promise<void> {
    if (this.btpClient) {
      await this.btpClient.disconnect();
      this.btpClient = null;
    }
  }

  /** Whether the socket is open now: read from the socket, so a drop is seen at once. */
  get isConnected(): boolean {
    return this.btpClient?.isConnected === true;
  }

  /**
   * Sends an ILP packet via BTP, connecting first if the socket is not open.
   * One attempt; see the class docs for what a failure says.
   *
   * `params` may carry an `expectedFulfillment` (the sender's end-to-end
   * check, ADR 0069), a `greeting` flag and an explicit `expiresAt`. With an
   * expected fulfilment the FULFILL preimage is compared against it and a
   * mismatch is surfaced as a failed result — see `mapIlpResponse`.
   */
  async sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult> {
    return this.sendOnce(params, []);
  }

  /**
   * Sends an ILP packet carrying a voucher claim as BTP protocol data, in the
   * same frame. One attempt, exactly as {@link sendIlpPacket}.
   *
   * `expectedFulfillment` / `greeting` / `expiresAt` semantics are identical
   * to {@link sendIlpPacket}.
   */
  async sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: Record<string, unknown>
  ): Promise<IlpSendResult> {
    return this.sendOnce(params, [
      {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: encodeUtf8(JSON.stringify(claim)),
      },
    ]);
  }

  /**
   * Build the ILP PREPARE for a send, applying the
   * explicit expiry when provided, carrying the `greeting` flag ADR 0069 put
   * where the execution condition used to be, and validating that an expected
   * fulfilment is exactly 32 bytes (a wrong-length one could never match a
   * real FULFILL, so every delivery would be counted failed).
   */
  private buildPrepare(params: IlpSendParams): {
    prepare: {
      type: 12;
      amount: bigint;
      destination: string;
      greeting: boolean;
      expiresAt: Date;
      data: Uint8Array;
    };
    expectedFulfillment: Uint8Array | undefined;
  } {
    const expectedFulfillment = resolveExpectedFulfillment(
      params.expectedFulfillment
    );
    if (expectedFulfillment !== undefined) {
      assertValidFulfillment(expectedFulfillment);
    }
    return {
      prepare: {
        type: 12 as const,
        amount: BigInt(params.amount),
        destination: params.destination,
        greeting: params.greeting ?? false,
        expiresAt: resolveExpiresAt(params.expiresAt, params.timeout ?? 30000),
        data: fromBase64(params.data),
      },
      expectedFulfillment,
    };
  }

  /**
   * One attempt: connect if the socket is not open, then write the frame once.
   *
   * Everything up to `sendPacket` happens before a byte of the packet leaves,
   * and a failure there is {@link NothingWritten}. `sendPacket` writes the frame
   * before its first `await`, so once it is called the packet has left — or may
   * have — and a failure after that is passed on as it is.
   */
  private async sendOnce(
    params: IlpSendParams,
    protocolData: BTPProtocolData[]
  ): Promise<IlpSendResult> {
    const { prepare, expectedFulfillment } = this.buildPrepare(params);
    if (!this.isConnected) {
      try {
        await this.reconnect();
      } catch (error) {
        throw new NothingWritten(error);
      }
    }
    const client = this.btpClient;
    if (client === null || !client.isConnected) {
      throw new NothingWritten(new BtpConnectionError('BTP client not connected'));
    }
    const response = await client.sendPacket(prepare, protocolData);
    return {
      ...mapIlpResponse(response.packet, expectedFulfillment),
      ...readResponseMeta(response.protocolData),
    };
  }
}
