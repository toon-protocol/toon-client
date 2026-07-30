/**
 * A fake terminating connector for tests: it holds an identity key, answers
 * `GET /ilp/identity` with it, opens what a sender sealed to it, and seals its
 * answer back with the secret it recovered.
 *
 * It exists because a sealed exchange cannot be faked one half at a time. A
 * test that hand-writes FULFILL bytes has to hand-write the seal too, which
 * means encoding this repo's own idea of the wire into the fixture — and a
 * mistake in the implementation would be copied faithfully into the
 * expectation. Here the ONLY way to produce a response the client can open is
 * to genuinely open the request first, so the two directions check each other.
 *
 * The crypto is the shipped crypto (`giftwrap.ts`, itself replayed against the
 * connector's committed vectors); nothing here reimplements it.
 *
 * Test-only. Nothing in `src/index.ts` reaches it, so it is not published.
 */

import {
  decodeEnvelopeRequest,
  encodeEnvelopeResponse,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from './envelope.js';
import {
  deriveFulfillment,
  localGiftWrapEcdh,
  openRequest,
  sealResponse,
} from './giftwrap.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toBase64, fromBase64 } from '../utils/binary.js';

/** What a request, once opened, turns out to have been. */
export interface OpenedPrepare {
  request: EnvelopeRequest;
  sharedSecret: Uint8Array;
  /** The fulfilment this connector would return: derived, never invented. */
  fulfillment: Uint8Array;
}

export interface FakeTerminatingConnectorOptions {
  /** 32-byte identity secret. Default: a fixed, obviously-test key. */
  identitySecret?: Uint8Array;
  /** The client-edge origin this connector answers on. */
  endpoint?: string;
}

/**
 * A connector that terminates every packet it is handed.
 *
 * `answer` is what the app behind it says; set it per test. `opened` records
 * every request it decoded, so a test can assert on what actually crossed the
 * wire rather than on what the caller intended to send.
 */
export class FakeTerminatingConnector {
  readonly identitySecret: Uint8Array;
  readonly identityPublic: Uint8Array;
  readonly endpoint: string;
  readonly opened: OpenedPrepare[] = [];

  /** The app's answer. Replace to drive a different status/body. */
  answer: EnvelopeResponse = {
    status: 200,
    headers: [['content-type', 'application/json']],
    body: new TextEncoder().encode('{"ok":true}'),
  };

  /**
   * What every destination costs here — the flat per-handler price ADR 0020
   * makes a route's whole fee. `null` means this connector terminates no
   * matching route, which it reports as the `404` a real one does.
   */
  routePrice: bigint | null = 1000n;

  constructor(options: FakeTerminatingConnectorOptions = {}) {
    this.identitySecret = options.identitySecret ?? new Uint8Array(32).fill(9);
    this.identityPublic = secp256k1.getPublicKey(this.identitySecret, false);
    this.endpoint = options.endpoint ?? 'http://connector.test';
  }

  /** `0x`-prefixed uncompressed hex, exactly as `GET /ilp/identity` reports. */
  get publicKeyHex(): string {
    return `0x${Array.from(this.identityPublic, (b) =>
      b.toString(16).padStart(2, '0')
    ).join('')}`;
  }

  /**
   * A `fetch` serving this connector's client edge — `/ilp/identity` and
   * `/ilp/routes/price`, the two endpoints a sender must consult before it
   * can form a packet. Anything else 404s, so a test that reaches an
   * unexpected route fails loudly.
   */
  fetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/ilp/identity')) {
      return new Response(
        JSON.stringify({ keyId: 'fake', publicKey: this.publicKeyHex }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/ilp/routes/price')) {
      if (this.routePrice === null) {
        return new Response('no route', { status: 404 });
      }
      const destination =
        new URL(url, 'http://x.invalid').searchParams.get('destination') ?? '';
      return new Response(
        // `price` is a JSON NUMBER on this endpoint, as the connector emits it.
        JSON.stringify({ destination, price: Number(this.routePrice) }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  /**
   * Open a base64 PREPARE `data` as this connector would, recording it.
   *
   * Enforces ADR 0025 (connector #596) on the envelope's target exactly as
   * `resolve_target_under_handler` does: a target is resolved strictly
   * beneath the route's handler path, so `''` and `'/'` mean "the handler's
   * own path" and anything else starting with `/`, containing a `..`/`.`
   * segment, a backslash, or a scheme is refused. A fake that accepted
   * `'/write'` here while the real edge answers F00 is exactly the drift
   * ADR 0007 forbids — and is how the suite stayed green while the deployed
   * connector refused every default-target write.
   *
   * @throws whatever `openRequest`/`decodeEnvelopeRequest` throw — a test
   *   sending unsealed or misdirected bytes should fail here, loudly.
   * @throws {Error} on a target ADR 0025 refuses, mirroring the F00 reject.
   */
  open(dataBase64: string): OpenedPrepare {
    const { envelopeBytes, sharedSecret } = openRequest(
      fromBase64(dataBase64),
      localGiftWrapEcdh(this.identitySecret)
    );
    const request = decodeEnvelopeRequest(envelopeBytes);
    assertTargetStaysUnderHandler(request.target);
    const entry: OpenedPrepare = {
      request,
      sharedSecret,
      fulfillment: deriveFulfillment(sharedSecret),
    };
    this.opened.push(entry);
    return entry;
  }

  /**
   * Handle a PREPARE end to end: open it, then seal {@link answer} back — the
   * FULFILL an `IlpSendResult` would carry, including the derived fulfilment
   * the sender's condition check will be run against.
   */
  fulfill(dataBase64: string): {
    accepted: true;
    data: string;
    fulfillment: string;
  } {
    const { sharedSecret, fulfillment } = this.open(dataBase64);
    return {
      accepted: true,
      data: toBase64(
        sealResponse(sharedSecret, encodeEnvelopeResponse(this.answer))
      ),
      fulfillment: toBase64(fulfillment),
    };
  }

  /**
   * A REJECT raised AT the termination: sealed with the request's own secret,
   * which is what makes "the destination said no" provable.
   */
  rejectSealed(
    dataBase64: string,
    code = 'F99',
    message = 'the app refused',
    detail = new Uint8Array(0)
  ): { accepted: false; code: string; message: string; data: string } {
    const { sharedSecret } = this.open(dataBase64);
    return {
      accepted: false,
      code,
      message,
      data: toBase64(sealResponse(sharedSecret, detail)),
    };
  }
}

/**
 * ADR 0025's target rule, the fake's copy of the connector's
 * `resolve_target_under_handler` core: `''`/`'/'` name the handler's own
 * path; any other leading `/` is an absolute-path escape; `..`/`.` segments,
 * backslashes and schemes (plus their percent-encoded forms) are refusals.
 */
function assertTargetStaysUnderHandler(target: string): void {
  const path = target.split('?')[0] ?? '';
  if (path === '' || path === '/') return;
  if (path.startsWith('/')) {
    throw new Error(
      `F00: envelope target '${target}' is an absolute path -- it must be ` +
        "relative to the route's handler path, never in place of it"
    );
  }
  const decoded = decodeURIComponent(path);
  const escapes =
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded) ||
    decoded.split('/').some((segment) => segment === '..' || segment === '.');
  if (escapes) {
    throw new Error(
      `F00: envelope target '${target}' attempts to escape the route's handler path`
    );
  }
}

/**
 * A REJECT raised SHORT of the termination: plaintext, because an
 * intermediate hop shares no secret and cannot seal anything.
 */
export function plaintextReject(
  code = 'F02',
  message = 'no route to destination'
): { accepted: false; code: string; message: string } {
  return { accepted: false, code, message };
}
