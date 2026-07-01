/**
 * Fastify route registration for the `toon-clientd` control API. Each route
 * is a thin adapter: parse/validate the request, call the `ClientRunner`, map
 * errors to the uniform `ErrorResponse` envelope.
 *
 * Bound to loopback only by the daemon entry — there is no auth layer because
 * the surface never leaves `127.0.0.1`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { NostrEvent } from 'nostr-tools/pure';
import type { ClientRunner } from './client-runner.js';
import {
  BalancesUnavailableError,
  InvalidPayloadError,
  NotReadyError,
  PublishRejectedError,
  TargetError,
} from './client-runner.js';
import { ApexDiscoveryError } from './apex-discovery.js';
import type {
  AddApexRequest,
  AddRelayRequest,
  EventsQuery,
  FundWalletRequest,
  HttpFetchPaidRequest,
  ChannelDepositRequest,
  CloseChannelRequest,
  SettleChannelRequest,
  OpenChannelRequest,
  PublishRequest,
  PublishUnsignedRequest,
  QueryRequest,
  RemoveApexRequest,
  RemoveRelayRequest,
  SettlementChain,
  SubscribeRequest,
  SwapRequest,
  UploadMediaRequest,
} from '../control-api.js';

export function registerRoutes(
  app: FastifyInstance,
  runner: ClientRunner
): void {
  app.get('/status', async () => runner.getStatus());

  app.post<{ Body: PublishRequest }>('/publish', async (req, reply) => {
    const body = req.body;
    if (!body || !isSignedEvent(body.event)) {
      return sendError(reply, 400, 'invalid_event', {
        detail: 'body.event must be a fully-signed Nostr event (id + sig).',
      });
    }
    try {
      return await runner.publish(body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: PublishUnsignedRequest }>(
    '/publish-unsigned',
    async (req, reply) => {
      const body = req.body;
      if (!body || !Number.isInteger(body.kind)) {
        return sendError(reply, 400, 'invalid_event', {
          detail: 'body.kind (integer) is required; the daemon signs the event.',
        });
      }
      try {
        return await runner.publishUnsigned(body);
      } catch (err) {
        return mapError(reply, err);
      }
    }
  );

  app.post<{ Body: UploadMediaRequest }>('/upload-media', async (req, reply) => {
    const body = req.body;
    const hasData = typeof body?.dataBase64 === 'string' && body.dataBase64 !== '';
    const hasPath = typeof body?.filePath === 'string' && body.filePath !== '';
    if (!body || (!hasData && !hasPath)) {
      return sendError(reply, 400, 'invalid_media', {
        detail:
          'body.dataBase64 (base64-encoded media bytes) or body.filePath (absolute path) is required.',
      });
    }
    try {
      return await runner.uploadMedia(body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: QueryRequest }>('/query', async (req, reply) => {
    const body = req.body;
    if (!body || body.filters === undefined) {
      return sendError(reply, 400, 'invalid_filters', {
        detail: 'body.filters is required (a NIP-01 filter or array of filters).',
      });
    }
    try {
      const events = await runner.query(body.filters, body.timeoutMs);
      return { events };
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: SubscribeRequest }>('/subscribe', async (req, reply) => {
    const body = req.body;
    if (!body || body.filters === undefined) {
      return sendError(reply, 400, 'invalid_filters', {
        detail:
          'body.filters is required (a NIP-01 filter or array of filters).',
      });
    }
    try {
      return runner.subscribe(body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{
    Querystring: {
      subId?: string;
      cursor?: string;
      limit?: string;
      relayUrl?: string;
    };
  }>('/events', async (req) => {
    const q = req.query;
    const query: EventsQuery = {};
    if (q.subId) query.subId = q.subId;
    if (q.cursor !== undefined) query.cursor = Number(q.cursor);
    if (q.limit !== undefined) query.limit = Number(q.limit);
    if (q.relayUrl) query.relayUrl = q.relayUrl;
    return runner.getEvents(query);
  });

  app.post<{ Body: OpenChannelRequest }>('/channels', async (req, reply) => {
    try {
      return await runner.openChannel(req.body?.destination);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get('/channels', async () => runner.getChannels());

  app.get('/balances', async (_req, reply) => {
    try {
      return await runner.getBalances();
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: ChannelDepositRequest }>('/channels/deposit', async (req, reply) => {
    try {
      return await runner.depositToChannel(req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: CloseChannelRequest }>('/channels/close', async (req, reply) => {
    try {
      return await runner.closeChannel(req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: SettleChannelRequest }>('/channels/settle', async (req, reply) => {
    try {
      return await runner.settleChannel(req.body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: SwapRequest }>('/swap', async (req, reply) => {
    const body = req.body;
    if (
      !body ||
      !body.destination ||
      body.amount === undefined ||
      !body.swapPubkey ||
      !body.pair ||
      !body.chainRecipient
    ) {
      return sendError(reply, 400, 'invalid_swap', {
        detail:
          'body.destination, amount, swapPubkey, pair, and chainRecipient are required.',
      });
    }
    try {
      return await runner.swap(body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: HttpFetchPaidRequest }>(
    '/http-fetch-paid',
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.url !== 'string' || body.url === '') {
        return sendError(reply, 400, 'invalid_url', {
          detail: 'body.url (absolute resource URL) is required.',
        });
      }
      try {
        return await runner.httpFetchPaid(body);
      } catch (err) {
        return mapError(reply, err);
      }
    }
  );

  app.post<{ Body: FundWalletRequest }>('/fund-wallet', async (req, reply) => {
    try {
      // Returns immediately with a 'pending' snapshot — the drip runs async in
      // the daemon (the Mina faucet outlasts the host's tool-call timeout).
      return runner.fundWallet(req.body ?? {});
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{ Querystring: { chain?: SettlementChain } }>(
    '/fund-wallet/status',
    async (req) => runner.getFundStatus(req.query?.chain)
  );

  app.get('/targets', async () => runner.getTargets());

  app.post<{ Body: AddRelayRequest }>('/relays', async (req, reply) => {
    const url = req.body?.relayUrl;
    if (!url) {
      return sendError(reply, 400, 'invalid_relay', {
        detail: 'body.relayUrl is required.',
      });
    }
    try {
      await runner.addRelay(url);
      return runner.getTargets();
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.delete<{ Body: RemoveRelayRequest }>('/relays', async (req, reply) => {
    const url = req.body?.relayUrl;
    if (!url) {
      return sendError(reply, 400, 'invalid_relay', {
        detail: 'body.relayUrl is required.',
      });
    }
    try {
      runner.removeRelay(url);
      return runner.getTargets();
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Body: AddApexRequest }>('/apex', async (req, reply) => {
    const body = req.body;
    if (!body || !body.ilpAddress || !body.relayUrl) {
      return sendError(reply, 400, 'invalid_apex', {
        detail: 'body.ilpAddress and body.relayUrl are required.',
      });
    }
    try {
      return await runner.addApex(body);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.delete<{ Body: RemoveApexRequest }>('/apex', async (req, reply) => {
    const url = req.body?.btpUrl;
    if (!url) {
      return sendError(reply, 400, 'invalid_apex', {
        detail: 'body.btpUrl is required.',
      });
    }
    try {
      await runner.removeApex(url);
      return runner.getTargets();
    } catch (err) {
      return mapError(reply, err);
    }
  });
}

function isSignedEvent(event: unknown): event is NostrEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    typeof e['sig'] === 'string' &&
    typeof e['pubkey'] === 'string' &&
    typeof e['kind'] === 'number'
  );
}

function mapError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotReadyError) {
    return sendError(reply, 503, 'bootstrapping', {
      detail: err.message,
      retryable: true,
    });
  }
  if (err instanceof InvalidPayloadError) {
    return sendError(reply, 400, 'invalid_payload', { detail: err.message });
  }
  if (err instanceof PublishRejectedError) {
    return sendError(reply, 502, 'rejected', { detail: err.message });
  }
  if (err instanceof BalancesUnavailableError) {
    // The chain RPC/provider behind the balances handler stalled — retryable,
    // and attributed to the balances handler, NOT the relay/apex (#199).
    return sendError(reply, 504, 'balances_unavailable', {
      detail: err.message,
      retryable: true,
    });
  }
  if (err instanceof TargetError) {
    // 404 for "no such target", 400 otherwise — both are caller-fixable.
    const status = /no such/i.test(err.message) ? 404 : 400;
    return sendError(reply, status, 'invalid_target', { detail: err.message });
  }
  if (err instanceof ApexDiscoveryError) {
    // A timeout is a retryable 504 (apex may be slow/offline); a malformed
    // announcement is a non-retryable 502 (the apex must republish).
    return err.retryable
      ? sendError(reply, 504, 'discovery_timeout', {
          detail: err.message,
          retryable: true,
        })
      : sendError(reply, 502, 'discovery_failed', { detail: err.message });
  }
  // Settle called before the grace period elapsed — retryable (the UI polls
  // until `now >= settleableAt`). The client throws a tagged error; 425 Too Early.
  if (err instanceof Error && (err as { name?: string }).name === 'SettleTooEarlyError') {
    return sendError(reply, 425, 'settle_too_early', { detail: err.message, retryable: true });
  }
  // First-write channel OPEN reverted because the settlement wallet has no
  // native gas (toon-meta#65). The client throws a tagged `ChannelFundingError`
  // with an actionable "fund the wallet" message; on the upload path it is
  // wrapped in a `ToonClientError('Failed to publish event')`, so walk the
  // `cause` chain. 402 Payment Required — caller-fixable + retryable once funded.
  const funding = findChannelFundingError(err);
  if (funding) {
    return sendError(reply, 402, 'insufficient_gas', {
      detail: funding.message,
      retryable: true,
    });
  }
  return sendError(reply, 500, 'internal_error', {
    detail: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Walk an error's `cause` chain and return the first `ChannelFundingError`
 * (matched by name to avoid a hard import of the client package). The client
 * tags the gas-revert error and `publishEvent` wraps it one level deep on the
 * upload path, so the actionable message can be nested.
 */
function findChannelFundingError(err: unknown): Error | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur != null; i++) {
    if (cur instanceof Error && (cur as { name?: string }).name === 'ChannelFundingError') {
      return cur;
    }
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  extra: { detail?: string; retryable?: boolean } = {}
): FastifyReply {
  return reply.status(status).send({
    error,
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.retryable ? { retryable: true } : {}),
  });
}
