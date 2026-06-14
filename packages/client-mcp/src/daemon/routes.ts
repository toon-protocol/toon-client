/**
 * Fastify route registration for the `toon-clientd` control plane. Each route
 * is a thin adapter: parse/validate the request, call the `ClientRunner`, map
 * errors to the uniform `ErrorResponse` envelope.
 *
 * Bound to loopback only by the daemon entry — there is no auth layer because
 * the surface never leaves `127.0.0.1`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { NostrEvent } from 'nostr-tools/pure';
import type { ClientRunner } from './client-runner.js';
import { NotReadyError, PublishRejectedError } from './client-runner.js';
import type {
  EventsQuery,
  OpenChannelRequest,
  PublishRequest,
  SubscribeRequest,
  SwapRequest,
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

  app.post<{ Body: SubscribeRequest }>('/subscribe', async (req, reply) => {
    const body = req.body;
    if (!body || body.filters === undefined) {
      return sendError(reply, 400, 'invalid_filters', {
        detail:
          'body.filters is required (a NIP-01 filter or array of filters).',
      });
    }
    return runner.subscribe(body);
  });

  app.get<{ Querystring: { subId?: string; cursor?: string; limit?: string } }>(
    '/events',
    async (req) => {
      const q = req.query;
      const query: EventsQuery = {};
      if (q.subId) query.subId = q.subId;
      if (q.cursor !== undefined) query.cursor = Number(q.cursor);
      if (q.limit !== undefined) query.limit = Number(q.limit);
      return runner.getEvents(query);
    }
  );

  app.post<{ Body: OpenChannelRequest }>('/channels', async (req, reply) => {
    try {
      return await runner.openChannel(req.body?.destination);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get('/channels', async () => runner.getChannels());

  app.post<{ Body: SwapRequest }>('/swap', async (req, reply) => {
    const body = req.body;
    if (
      !body ||
      !body.destination ||
      body.amount === undefined ||
      !body.millPubkey ||
      !body.pair ||
      !body.chainRecipient
    ) {
      return sendError(reply, 400, 'invalid_swap', {
        detail:
          'body.destination, amount, millPubkey, pair, and chainRecipient are required.',
      });
    }
    try {
      return await runner.swap(body);
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
  if (err instanceof PublishRejectedError) {
    return sendError(reply, 502, 'rejected', { detail: err.message });
  }
  return sendError(reply, 500, 'internal_error', {
    detail: err instanceof Error ? err.message : String(err),
  });
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
