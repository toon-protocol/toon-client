import { describe, it, expect, vi } from 'vitest';
import type { ControlClient } from '../control-client.js';
import { CATALOG_ATOM_IDS, WRITE_TOOLS, validateViewSpec } from '@toon-protocol/views';
import { runJourney } from './runner.js';
import { socialFiJourney } from './socialfi.js';

const TEST_PUBKEY = 'a'.repeat(64);

function stubClient(impl: Partial<Record<keyof ControlClient, unknown>>): ControlClient {
  return impl as unknown as ControlClient;
}

const fakeStatus = {
  ready: true,
  bootstrapping: false,
  uptimeMs: 1000,
  settlementChain: 'evm' as const,
  identity: { nostrPubkey: TEST_PUBKEY },
  transport: { type: 'direct' as const },
  relay: { url: 'wss://relay.example', connected: true, buffered: 0, subscriptions: [] },
  channel: null,
  apexes: [],
  relays: [],
};

const fakePublishResponse = {
  eventId: 'evt123',
  channelId: 'ch1',
  nonce: 1,
};

const fakeUploadResponse = {
  eventId: 'evt456',
  channelId: 'ch1',
  nonce: 2,
  url: 'https://arweave.net/abc123',
  txId: 'arweave-tx-1',
};

describe('socialFiJourney', () => {
  it('returns exactly 5 ordered steps', () => {
    const plan = socialFiJourney({ pubkey: TEST_PUBKEY });
    expect(plan.id).toBe('socialfi');
    const ids = plan.steps.map((s) => s.id);
    expect(ids).toEqual(['onboard', 'publish-profile', 'publish-note', 'follow', 'dvm-upload']);
  });

  it('completes the full sequence with mocked ControlClient', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    const plan = socialFiJourney({ pubkey: TEST_PUBKEY });
    const result = await runJourney(plan, client);

    expect(result.completed).toBe(true);
    expect(result.steps).toHaveLength(5);
    expect(result.error).toBeUndefined();
  });

  it('step 1 (onboard) calls status() with no args', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    await runJourney(socialFiJourney({ pubkey: TEST_PUBKEY }), client);

    expect(status).toHaveBeenCalledOnce();
  });

  it('step 2 (publish-profile) calls publishUnsigned with kind:0', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    await runJourney(socialFiJourney({ pubkey: TEST_PUBKEY }), client);

    expect(publishUnsigned).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 0 })
    );
  });

  it('step 3 (publish-note) calls publishUnsigned with kind:1', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    await runJourney(socialFiJourney({ pubkey: TEST_PUBKEY }), client);

    expect(publishUnsigned).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 1 })
    );
  });

  it('step 4 (follow) calls publishUnsigned with kind:3 and threads pubkey from onboard state', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    await runJourney(socialFiJourney(), client); // no opts.pubkey — must read from state

    expect(publishUnsigned).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 3, tags: [['p', TEST_PUBKEY]] })
    );
  });

  it('step 4 (follow) renderPanel action tags use state-threaded pubkey when opts is omitted', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    const result = await runJourney(socialFiJourney(), client); // no opts — must read pubkey from state

    const followStep = result.steps.find((s) => s.stepId === 'follow');
    expect(followStep).toBeDefined();
    const viewSpec = followStep!.panel.structuredContent?.['viewSpec'] as {
      root: { children: Array<{ actions?: { follow?: { args?: { tags?: string[][] } } } }> };
    };
    const followButtonActions = viewSpec.root.children[0]?.actions?.follow;
    expect(followButtonActions?.args?.tags).toEqual([['p', TEST_PUBKEY]]);
  });

  it('step 5 (dvm-upload) calls uploadMedia with the correct payload', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    await runJourney(socialFiJourney({ pubkey: TEST_PUBKEY }), client);

    expect(uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ dataBase64: '', mime: 'image/png', kind: 1063 })
    );
  });

  it('every step panel passes validateViewSpec', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    const result = await runJourney(socialFiJourney({ pubkey: TEST_PUBKEY }), client);

    for (const step of result.steps) {
      const viewSpec = step.panel.structuredContent?.['viewSpec'];
      expect(viewSpec).toBeDefined();
      const check = validateViewSpec(viewSpec, {
        allowedAtoms: CATALOG_ATOM_IDS,
        allowedTools: WRITE_TOOLS,
      });
      expect(check.ok).toBe(true);
    }
  });

  it('halts and returns partial result on tool error at step 2', async () => {
    const status = vi.fn().mockResolvedValue(fakeStatus);
    const publishUnsigned = vi.fn().mockRejectedValue(new Error('daemon error'));
    const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);

    const client = stubClient({ status, publishUnsigned, uploadMedia });
    const result = await runJourney(socialFiJourney({ pubkey: TEST_PUBKEY }), client);

    expect(result.completed).toBe(false);
    expect(result.steps).toHaveLength(1); // only onboard completed
    expect(result.error?.stepId).toBe('publish-profile');
    expect(uploadMedia).not.toHaveBeenCalled();
  });
});
