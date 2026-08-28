/**
 * One paid POST, one decoded receipt — and the three different ways a job can
 * come back without one.
 *
 * The distinction this suite exists to hold: a gate that DECLINED is not a
 * failure here. `accept: true` with a `status: 'failed'` receipt is a job that
 * ran, and it comes back as `accepted: true` with that receipt inside, for the
 * caller to branch on. `accepted: false` means only that there is no receipt.
 */

import { describe, it, expect, vi } from 'vitest';
import { toBase64, encodeUtf8 } from '../utils/binary.js';
import { buildJobEvent } from './job-event.js';
import { sendJob, type JobSender } from './send-job.js';
import { accepted, answered, refused, rejected } from './ant-spawn.test-support.js';

const EVENT = buildJobEvent({ kind: 5096, params: { phase: 'quote' } });

function sender(result: ReturnType<typeof accepted>): JobSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(result) };
}

describe('sendJob', () => {
  it('POSTs the event as JSON to the route, and passes the seal through', async () => {
    const client = sender(accepted({ ok: true }));

    await sendJob(
      { client, destination: 'g.toon.relay.gas', sealTo: 'https://gas.example', timeoutMs: 9000 },
      EVENT
    );

    expect(client.send).toHaveBeenCalledWith(
      'g.toon.relay.gas',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { event: EVENT },
      },
      // A forwarded route needs the terminating node named explicitly — no hop
      // may name that key on its behalf.
      { sealTo: 'https://gas.example', timeoutMs: 9000 }
    );
  });

  it('omits sealTo entirely when the route is not forwarded', async () => {
    const client = sender(accepted({ ok: true }));
    await sendJob({ client, destination: 'g.toon.gas' }, EVENT);
    expect(client.send).toHaveBeenCalledWith('g.toon.gas', expect.anything(), {});
  });

  it('decodes the receipt from `data`, the byte-faithful copy', async () => {
    const receipt = { job: 'gas-station', quoteId: 'q1' };
    const client = sender(
      answered(200, {
        accept: true,
        data: toBase64(encodeUtf8(JSON.stringify(receipt))),
        // Deliberately disagreeing: `data` is the one that must win.
        result: { job: 'gas-station', quoteId: 'stale' },
      })
    );

    const answer = await sendJob<{ quoteId: string }>(
      { client, destination: 'g.toon.gas' },
      EVENT
    );
    expect(answer).toEqual({ accepted: true, receipt });
  });

  it('falls back to `result` when there is no usable `data`', async () => {
    const client = sender(answered(200, { accept: true, result: { quoteId: 'q1' } }));
    const answer = await sendJob<{ quoteId: string }>(
      { client, destination: 'g.toon.gas' },
      EVENT
    );
    expect(answer).toEqual({ accepted: true, receipt: { quoteId: 'q1' } });
  });

  it('hands back a gate refusal as a RECEIPT, because it is one', async () => {
    const failure = {
      job: 'gas-station',
      phase: 'quote',
      status: 'failed',
      reason: 'float_exhausted',
      detail: 'fee-payer float 0 lamports',
    };
    const client = sender(accepted(failure));

    // The DVM was asked a question and applied its rules. That is a successful
    // job with a machine-readable answer, not a transport problem.
    expect(await sendJob({ client, destination: 'g.toon.gas' }, EVENT)).toEqual({
      accepted: true,
      receipt: failure,
    });
  });

  it('reports a packet the connector would not carry', async () => {
    const client = sender(refused('F03', 'insufficient amount'));
    const answer = await sendJob({ client, destination: 'g.toon.gas' }, EVENT);

    expect(answer.accepted).toBe(false);
    if (answer.accepted) throw new Error('unreachable');
    expect(answer.code).toBe('F03');
    expect(answer.message).toContain('kind:5096 refused by destination');
    expect(answer.refusal?.code).toBe('F03');
  });

  it('reports an event the app rejected, with the app\'s own code', async () => {
    const client = sender(rejected('F00', "kind:5096 needs ['param','phase',…]"));
    const answer = await sendJob({ client, destination: 'g.toon.gas' }, EVENT);

    expect(answer).toEqual({
      accepted: false,
      code: 'F00',
      message: "kind:5096 needs ['param','phase',…]",
    });
    // It was rejected by the app, not by the path: nothing to blame the wire for.
    if (answer.accepted) throw new Error('unreachable');
    expect(answer.refusal).toBeUndefined();
  });

  it('reports an accepted answer that carried no receipt', async () => {
    const client = sender(answered(200, { accept: true }));
    const answer = await sendJob({ client, destination: 'g.toon.gas' }, EVENT);
    expect(answer).toMatchObject({ accepted: false, code: 'F00' });
  });

  it('reports a body that is not JSON at all', async () => {
    const bytes = encodeUtf8('<html>502 Bad Gateway</html>');
    const client = sender({
      fulfilled: true,
      transport: 'http',
      status: 502,
      headers: [],
      body: bytes,
      text: () => '<html>502 Bad Gateway</html>',
      json: () => {
        throw new Error('not JSON');
      },
      fulfillment: new Uint8Array(32),
    });

    const answer = await sendJob({ client, destination: 'g.toon.gas' }, EVENT);
    expect(answer).toMatchObject({ accepted: false, code: 'F00' });
    if (answer.accepted) throw new Error('unreachable');
    expect(answer.message).toContain('502 Bad Gateway');
  });
});
