/**
 * One paid request, end to end.
 *
 * This is the composition the whole package exists to perform, and it is written
 * as one readable function plus its helpers because the ORDER is the contract:
 *
 * 1. **Describe the node** (`GET /ilp`). Everything else reads off this one
 *    document — the sealing key, the settlement chains, the endpoints.
 * 2. **Get the sealing key.** The payload is sealed to the connector that
 *    TERMINATES the route (`client-edge-spec.md` §1.8, ADR 0018), so a forwarded
 *    destination needs {@link SendOptions.sealTo} naming that node; sealing to a
 *    forwarder is a confidentiality failure the wire can only report as an
 *    undeliverable packet.
 * 3. **Seal.** {@link sealExchange} mints the gift wrap, the execution condition
 *    and the shared secret together, so they cannot drift: the condition is
 *    `sha256` of the fulfilment derived from the secret inside the wrap, and the
 *    answer is sealed back with that same secret.
 * 4. **Ask the price**, and charge it against the sealed payload. A route's base
 *    price is flat per handler — the route table IS the price list — but a route
 *    MAY also publish a `pricePerKib` and meter by the size of the sealed
 *    payload, which is why this step follows the seal rather than preceding it.
 *    The rate is the connector's; the arithmetic
 *    ({@link ../connector/self-description.js!chargeFor}) is the only thing
 *    computed locally, and a wrong answer is refused `F03` with the real figure
 *    attached rather than silently overpaid.
 * 5. **Ensure a channel**, then **sign a claim** on it for that amount.
 * 6. **Choose a carriage and send.**
 * 7. **Read the answer** with the secret from step 4.
 *
 * ## Two things this deliberately gets right
 *
 * **The watermark is repaid on every refusal.**
 * {@link ChannelManager.signBalanceProof} advances and persists the nonce and the
 * cumulative amount before the packet leaves, because a signed claim must never
 * be re-signable at the same nonce. When the connector then refuses the claim —
 * `F03` underpayment, `F03` over-deposit, `F01` unknown channel, or a
 * `claimAck.result === 'rejected'` riding beside any verdict — it banked nothing
 * (`client-edge-spec.md` §1.3: "a validation failure ... is rejected before it
 * reaches the terminating app or advances any watermark"), and our cumulative is
 * left inflated by value it never admitted. Every path that ends in a refusal
 * calls {@link ChannelManager.rollbackAmount}, including a thrown transport
 * error. The error case is a deliberate asymmetry: a lost response *may* have
 * been banked, so rolling back can leave us one claim short — and being short is
 * self-correcting (the next claim is refused `F03` with the price attached and
 * the client re-signs), whereas running ahead silently spends the channel's
 * deposit on nothing and eventually breaches the deposit ceiling.
 *
 * **`refusedBy` is honest about what is actually known.** A sealed reject is
 * proof: only the terminating connector could recover the secret needed to seal
 * one, so `'destination'` is a fact rather than an inference. A plaintext reject
 * identifies nobody — any hop can raise one, and so can a termination that could
 * not open the wrap — so it is `'path'`. A greeting is `'edge'`: the connector we
 * are attached to refused before routing at all.
 */
import {
  readExchangeOutcome,
  sealExchange,
  type SealedExchange,
} from '../wire/sealed-exchange.js';
import type { EnvelopeRequest } from '../wire/envelope.js';
import {
  chargeFor,
  type NodeSelfDescription,
  type RouteCharge,
} from '../connector/self-description.js';
import { decodeConnectorPublicKey } from '../connector/ConnectorEdgeClient.js';
import { parsePaymentTerms } from '../connector/x402.js';
import type { IlpSendResult } from '../ilp/types.js';
import type { IlpSendParams } from '../ilp/ilp-send.js';
import type { ChannelManager } from '../channel/ChannelManager.js';
import { isUnknownChannelReject, rejectNamesChannel } from '../channel/stale-channel.js';
import { toBase64, fromBase64, encodeUtf8, decodeUtf8 } from '../utils/binary.js';
import {
  PaymentRequiredError,
  RouteNotPricedError,
  TransportRequiredError,
  ValidationError,
} from './errors.js';
import type {
  ChainKind,
  ClaimSummary,
  PaymentTerms,
  SendOptions,
  SendRequest,
  SendResult,
} from './types.js';

/**
 * The narrowest thing that can carry a paid packet: one method.
 *
 * Deliberately narrower than {@link ../ilp/types.js!ClaimSendingTransport}, which
 * also requires the unpaid `sendIlpPacket`. Nothing in this pipeline ever sends
 * an unpaid packet — a request with no claim is answered with terms rather than
 * performed — and requiring the wider port would exclude
 * {@link ../btp/BtpPaidWriteTransport.js!BtpPaidWriteTransport}, whose whole
 * subject is paid writes.
 */
export interface PaidWriteTransport {
  sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: Record<string, unknown>
  ): Promise<IlpSendResult>;
  /**
   * The same packet with no claim attached, for a route priced at zero. Both
   * carriages have always offered it; only a free route uses it.
   */
  sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult>;
}

/**
 * Everything {@link send} needs from the client around it.
 *
 * A port rather than the `ToonClient` itself, so the composition can be tested
 * against a fake connector with no sockets, no chain and no keys beyond the ones
 * the claim actually needs — and so the carriage, which is the one part that
 * genuinely differs between deployments, stays behind one method.
 */
export interface SendContext {
  /** The node's `GET /ilp`, cached per client. */
  describe(): Promise<NodeSelfDescription>;
  /**
   * The key to seal to for the node described by `description`. Falls back to
   * `GET /ilp/identity` when the self-description carries no `edgeIdentity`.
   */
  sealKey(description: NodeSelfDescription): Promise<Uint8Array>;
  /** The sealing key of a DIFFERENT node, by its client-edge URL. */
  sealKeyAt(endpoint: string): Promise<Uint8Array>;
  /**
   * `GET /ilp/routes/price`; `null` when this node prices no matching route.
   *
   * The whole terms rather than one figure, because a route may meter by size
   * and the base price alone would under-pay it.
   */
  routePrice(destination: string): Promise<RouteCharge | null>;
  /** Open or adopt a channel with this node, returning its id. */
  ensureChannel(description: NodeSelfDescription): Promise<string>;
  /**
   * Retire the binding `channelId` was resolved through, so the next
   * {@link SendContext.ensureChannel} re-resolves. `false` when there was
   * nothing to retire — which is the signal NOT to retry.
   */
  evictChannel(channelId: string): boolean;
  /** The watermark and the signers. */
  channels: ChannelManager;
  /** The carriage, chosen and connected. */
  transport(description: NodeSelfDescription): Promise<{
    kind: 'http' | 'btp';
    transport: PaidWriteTransport;
  }>;
  /** The label every claim carries. Never an authority (connector ADR 0052). */
  senderId: string;
  /** The chain claims are signed on, for {@link ClaimSummary}. */
  chain: ChainKind;
  /** Per-packet timeout, in milliseconds. */
  timeoutMs: number;
  /** Where an operational warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Pay for one HTTP request through a connector, and return what the app said.
 *
 * @throws {RouteNotPricedError} the node prices no route covering `destination`
 *   and no explicit {@link SendOptions.amount} was given.
 * @throws Anything the chain or the network throws while opening a channel.
 *   A REJECT is never thrown — see {@link SendResult}.
 */
export async function send(
  context: SendContext,
  destination: string,
  request: SendRequest = {},
  options: SendOptions = {}
): Promise<SendResult> {
  const description = await context.describe();
  const sealingKey = await resolveSealingKey(context, description, options.sealTo);
  // Seal BEFORE pricing: a metered route charges by the size of the sealed
  // payload, which does not exist until `sealExchange` has run.
  const exchange = sealExchange(toEnvelopeRequest(request), sealingKey);
  const amount = await resolveAmount(
    context,
    destination,
    options.amount,
    exchange.data.length
  );
  const carriage = await context.transport(description);

  const first = await attempt(context, {
    destination,
    amount,
    exchange,
    carriage,
    description,
    timeoutMs: options.timeoutMs ?? context.timeoutMs,
  });

  // The bounded stale-channel recovery. `F01 — names a channel this connector
  // has no record of` is GROUND TRUTH that our binding is dead (a wiped
  // connector, a restored-from-backup box, a redeployed contract), where the
  // counterparty check that runs before a packet exists can only ever be a
  // prediction. Retire that binding, re-resolve, and retry the SAME packet once.
  //
  // Bounded deliberately: ONE retry, never a loop — a second `F01` is returned
  // as the failure it is, because a repeated eviction could open a channel per
  // request. And only when re-resolution actually MOVES: a retry onto the same
  // channel id would just repeat the reject.
  const retry = await maybeRetryStaleChannel(context, first, {
    destination,
    amount,
    exchange,
    carriage,
    description,
    timeoutMs: options.timeoutMs ?? context.timeoutMs,
  });
  return retry ?? first.result;
}

// ─── One attempt ────────────────────────────────────────────────────────────

interface AttemptParams {
  destination: string;
  amount: bigint;
  exchange: SealedExchange;
  carriage: { kind: 'http' | 'btp'; transport: PaidWriteTransport };
  description: NodeSelfDescription;
  timeoutMs: number;
}

/** One signed claim, one packet, one outcome — plus the channel it was drawn on. */
interface Attempt {
  result: SendResult;
  /** Absent for a free route, which opens no channel and signs nothing. */
  channelId: string | undefined;
}

async function attempt(context: SendContext, params: AttemptParams): Promise<Attempt> {
  // A route priced at zero is deliberately free, and free means no claim.
  //
  // The connector states this rather than leaving it implied: a terminated
  // route MUST carry a price, and `price = 0` is how an operator writes down
  // that they meant it, "because it is never silently free". Such a route is
  // not greeted and no claim gate runs on it — an unpaid request to an unpriced
  // destination is simply routed.
  //
  // So opening a payment channel to use one would be a real cost (gas, locked
  // collateral, an on-chain round trip) demanded for nothing. That is why this
  // path exists before `ensureChannel`: a free route must be usable by a client
  // that holds no channel and no funds at all.
  if (params.amount === 0n) return attemptUnpaid(context, params);

  const channelId = await context.ensureChannel(params.description);
  const proof = await context.channels.signBalanceProof(channelId, params.amount);
  const signer = context.channels.getSignerForChannel(channelId);
  const claim = signer.buildClaimMessage(proof, context.senderId);
  const summary: ClaimSummary = {
    channelId,
    chain: context.chain,
    nonce: proof.nonce,
    cumulative: proof.transferredAmount,
    amount: params.amount,
  };

  let result: IlpSendResult;
  try {
    result = await params.carriage.transport.sendIlpPacketWithClaim(
      {
        destination: params.destination,
        amount: params.amount.toString(),
        data: toBase64(params.exchange.data),
        executionCondition: params.exchange.condition,
        timeout: params.timeoutMs,
      },
      claim as unknown as Record<string, unknown>
    );
  } catch (error) {
    // Nothing is known to have arrived, so the claim is repaid. See this
    // module's docs for why being one claim short is the safer failure.
    context.channels.rollbackAmount(channelId, params.amount);
    const greeting = asGreeting(error, params.carriage.kind, summary);
    if (greeting) return { result: greeting, channelId };
    throw error;
  }

  if (claimWasRefused(result)) {
    context.channels.rollbackAmount(channelId, params.amount);
  }

  return {
    result: toSendResult(result, params, summary),
    channelId,
  };
}

/**
 * One attempt at a free route: the same sealed packet, with no claim attached.
 *
 * Everything else is identical — the envelope, the gift wrap, the condition
 * derived from the secret inside it, and the sealed answer read back with that
 * same secret. Only the payment is absent, because there is nothing to pay.
 */
async function attemptUnpaid(
  context: SendContext,
  params: AttemptParams
): Promise<Attempt> {
  const result = await params.carriage.transport.sendIlpPacket({
    destination: params.destination,
    amount: params.amount.toString(),
    data: toBase64(params.exchange.data),
    executionCondition: params.exchange.condition,
    timeout: params.timeoutMs,
  });
  return { result: toSendResult(result, params, undefined), channelId: undefined };
}

/**
 * Retry once against a re-resolved channel, when — and only when — the refusal
 * was the connector saying it holds no record of the channel we drew on.
 */
async function maybeRetryStaleChannel(
  context: SendContext,
  first: Attempt,
  params: AttemptParams
): Promise<SendResult | undefined> {
  const result = first.result;
  if (result.fulfilled) return undefined;
  if (!isUnknownChannelReject({ accepted: false, code: result.code, message: result.message })) {
    return undefined;
  }
  // A free route opens no channel, so there is no binding to retire.
  if (first.channelId === undefined) return undefined;
  const staleChannelId = first.channelId;
  if (!rejectNamesChannel(result.message, staleChannelId)) return undefined;
  if (!context.evictChannel(staleChannelId)) return undefined;

  (context.warn ?? console.warn)(
    `[toon] the connector refused a claim drawn on channel ${staleChannelId} ` +
      `(${result.code} — ${result.message}). It holds no record of that channel, ` +
      'so its binding is retired (superseded, so any on-chain deposit stays ' +
      'reclaimable) and the request is retried once against a re-resolved channel.'
  );

  const retry = await attempt(context, params);
  // Re-resolution landed on the same channel: the retry would repeat the reject,
  // so report the original refusal rather than spending a second claim on it.
  if (retry.channelId === first.channelId) return undefined;
  return retry.result;
}

// ─── Reading the outcome ────────────────────────────────────────────────────

/**
 * Did the connector refuse the CLAIM, as opposed to refusing the packet after
 * banking it?
 *
 * The distinction decides whether the local watermark is repaid, and getting it
 * backwards is expensive in both directions: repaying a claim the connector
 * banked leaves the next one short (refused `F03`), while not repaying one it
 * refused leaves every later claim overpaying.
 *
 * An explicit `claimAck` settles it outright — the connector's own verdict on the
 * claim, independent of the packet's. Without one, only the codes the claim gate
 * itself raises count: `F03` (underpaid, or over the deposit), `F01` (malformed,
 * a non-advancing nonce, or an unknown channel) and `F06` (no claim was seen at
 * all). A reject from further along the path — `F02` no route, `T0x`, `R00`
 * expiry — arrives *after* a valid claim advanced the watermark, so it must not
 * be repaid.
 */
function claimWasRefused(result: IlpSendResult): boolean {
  if (result.claimAck?.result === 'rejected') return true;
  if (result.claimAck?.result === 'accepted') return false;
  if (result.accepted) return false;
  return result.code === 'F03' || result.code === 'F01' || result.code === 'F06';
}

function toSendResult(
  result: IlpSendResult,
  params: AttemptParams,
  claim: ClaimSummary | undefined
): SendResult {
  const data = result.data === undefined ? undefined : fromBase64(result.data);
  const outcome = readExchangeOutcome(result, data, params.exchange.sharedSecret);
  const transport = params.carriage.kind;

  if (outcome.kind === 'answered') {
    const body = Uint8Array.from(outcome.response.body);
    return {
      fulfilled: true,
      transport,
      status: outcome.response.status,
      headers: outcome.response.headers.map(([name, value]): [string, string] => [name, value]),
      body,
      text: () => decodeUtf8(body),
      json: <T = unknown,>(): T => JSON.parse(decodeUtf8(body)) as T,
      fulfillment:
        result.fulfillment !== undefined
          ? fromBase64(result.fulfillment)
          : params.exchange.fulfillment,
      ...(claim !== undefined ? { claim } : {}),
      ...(result.claimAck !== undefined ? { claimAck: result.claimAck } : {}),
    };
  }

  // A greeting that arrived as a REJECT rather than an HTTP status: BTP answers
  // an unpaid or wrong-carriage request with `F06`/`F02` carrying the same terms
  // document a `402` would have. Terms are the tell, not the code.
  const terms = readTerms(result);

  return {
    fulfilled: false,
    transport,
    refusedBy:
      terms !== undefined
        ? 'edge'
        : outcome.kind === 'destination-refused'
          ? 'destination'
          : 'path',
    code: outcome.code,
    message: outcome.message,
    ...(result.accumulatedCost !== undefined ? { accumulatedCost: result.accumulatedCost } : {}),
    ...(result.claimAck !== undefined ? { claimAck: result.claimAck } : {}),
    ...(terms !== undefined ? { terms } : {}),
    ...(outcome.kind === 'destination-refused' && outcome.detail.length > 0
      ? { detail: outcome.detail }
      : {}),
    ...(claim !== undefined ? { claim } : {}),
  };
}

/**
 * The terms a reject carried, when it carried any.
 *
 * `paymentRequired` is the raw x402 document the connector attached beside the
 * packet — the `payment-required` protocolData entry on BTP. It is projected onto
 * {@link PaymentTerms} by the same parser the HTTP `402` path uses, so the two
 * carriages cannot come to different conclusions about one greeting.
 */
function readTerms(result: IlpSendResult): PaymentTerms | undefined {
  if (result.paymentRequired === undefined) return undefined;
  return parsePaymentTerms(result.paymentRequired);
}

/**
 * A refusal the transport threw because the connector answered with a status
 * rather than a packet — `402 Payment Required`, or a `402`/`401` naming a
 * carriage this route does not accept.
 *
 * Converted to a {@link SendResult} rather than propagated, because from
 * {@link send}'s contract these are refusals like any other: the packet did not
 * travel, nothing was paid, and the caller wants the terms, not a stack trace.
 * `refusedBy: 'edge'` — the connector we are attached to made this decision
 * before routing anything.
 */
function asGreeting(
  error: unknown,
  transport: 'http' | 'btp',
  claim: ClaimSummary
): SendResult | undefined {
  if (error instanceof PaymentRequiredError) {
    return {
      fulfilled: false,
      transport,
      refusedBy: 'edge',
      code: 'PAYMENT_REQUIRED',
      message: error.message,
      terms: error.terms,
      claim,
    };
  }
  if (error instanceof TransportRequiredError) {
    return {
      fulfilled: false,
      transport,
      refusedBy: 'edge',
      code: 'TRANSPORT_REQUIRED',
      message: error.message,
      ...(error.terms !== undefined ? { terms: error.terms } : {}),
      claim,
    };
  }
  return undefined;
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

/**
 * The key this packet's payload is sealed to.
 *
 * `sealTo` accepts the raw uncompressed key or the client-edge URL of the node
 * to seal to — the second because the caller of a *forwarded* route knows which
 * node terminates it but has no reason to hold that node's key, and no hop may
 * name it on the terminator's behalf (`self-description-spec.md` ND-13/ND-14).
 */
async function resolveSealingKey(
  context: SendContext,
  description: NodeSelfDescription,
  sealTo: Uint8Array | string | undefined
): Promise<Uint8Array> {
  if (sealTo === undefined) return context.sealKey(description);
  if (sealTo instanceof Uint8Array) return sealTo;
  const trimmed = sealTo.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return decodeConnectorPublicKey(trimmed);
  return context.sealKeyAt(trimmed);
}

/**
 * What to put on the packet.
 *
 * The terms are ASKED for rather than computed: nothing local could derive a
 * price, and anything local that tried could disagree with what the connector
 * will charge. What IS computed is the arithmetic the connector states — a route
 * that publishes a `pricePerKib` charges its base plus that rate per kibibyte of
 * `sealedBytes`, and {@link ../connector/self-description.js!chargeFor} is the
 * one place that rule lives.
 *
 * An explicit amount overrides and skips the lookup entirely, which is how a
 * forwarded destination — priced at a node this one only routes towards — is
 * paid for. It is taken literally, per-KiB rate and all: the caller who supplies
 * one is the caller who knows the far node's terms.
 */
async function resolveAmount(
  context: SendContext,
  destination: string,
  explicit: bigint | undefined,
  sealedBytes: number
): Promise<bigint> {
  if (explicit !== undefined) {
    if (explicit < 0n) {
      throw new ValidationError('`amount` cannot be negative — a claim advances, never retreats.');
    }
    return explicit;
  }
  const terms = await context.routePrice(destination);
  if (terms === null) {
    throw new RouteNotPricedError(
      `This connector prices no route covering "${destination}", so there is no ` +
        'amount to put on the packet. If the destination terminates elsewhere and ' +
        'this node only routes towards it, pass an explicit `amount` (and `sealTo`, ' +
        'naming the node that terminates it).'
    );
  }
  return chargeFor(terms, sealedBytes);
}

/**
 * A {@link SendRequest} as the envelope the wire carries.
 *
 * `target` defaults to `''` — the route's own handler path, which is the whole
 * answer for a route terminating at exactly one endpoint, and the only value
 * that cannot be refused: ADR 0025 resolves a target strictly BENEATH the
 * handler path, so an absolute `'/write'` is an escape attempt (`F00`) rather
 * than a shortcut.
 *
 * A plain object body is JSON, and says so: the connector hands the app the
 * headers this envelope carries, so a JSON body with no `content-type` reaches
 * an app that cannot tell what it is.
 */
export function toEnvelopeRequest(request: SendRequest): EnvelopeRequest {
  const headers = normalizeHeaders(request.headers);
  const { body, contentType } = normalizeBody(request.body);
  if (contentType !== undefined && !hasHeader(headers, 'content-type')) {
    headers.push(['content-type', contentType]);
  }
  return {
    method: request.method ?? 'POST',
    target: request.target ?? '',
    headers,
    body,
  };
}

function normalizeHeaders(
  headers: Record<string, string> | [string, string][] | undefined
): [string, string][] {
  if (headers === undefined) return [];
  // An array is a SEQUENCE, duplicates and order preserved — the wire's own
  // shape. An object cannot express either, which is why both are accepted.
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, value]);
  return Object.entries(headers).map(([name, value]): [string, string] => [name, value]);
}

function hasHeader(headers: [string, string][], name: string): boolean {
  return headers.some(([header]) => header.toLowerCase() === name);
}

function normalizeBody(body: SendRequest['body']): {
  body: Uint8Array;
  contentType?: string;
} {
  if (body === undefined) return { body: new Uint8Array(0) };
  if (body instanceof Uint8Array) return { body };
  if (typeof body === 'string') return { body: encodeUtf8(body) };
  return {
    body: encodeUtf8(JSON.stringify(body)),
    contentType: 'application/json',
  };
}
