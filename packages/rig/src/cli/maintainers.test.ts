/**
 * `rig maintainers list|add|remove` tests (#287): the FREE list read, the
 * PAID add/remove republish of the kind:30617 (owner-only), preservation of
 * name/description, and the non-owner refusal. The Publisher is mocked at the
 * StandaloneContext seam and a hermetic mock relay serves the current 30617.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import type { Publisher } from '../publisher.js';
import type { UnsignedEvent } from '../nip34-events.js';
import { parseMaintainers } from '../nip34-events.js';
import type { CliIo } from './output.js';
import type { EventCommandDeps } from './events.js';
import { runMaintainers } from './maintainers.js';
import type { StandaloneContext } from './standalone-context.js';
import { filterEvents, makeMockRelayFactory } from './read-testkit.js';

const OWNER = 'ab'.repeat(32);
const M1 = 'cd'.repeat(32);
const M2 = 'ef'.repeat(32);
const REPO = 'demo';
const RELAY = 'wss://relay.test.example';
const PUBLISHED_ID = '99'.repeat(32);

interface Recorder {
  io: CliIo;
  out: string[];
  err: string[];
  json: unknown[];
}

function makeIo(interactive = false, answer = false): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const json: unknown[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    emitJson: (payload) => json.push(payload),
    isInteractive: interactive,
    confirm: async () => answer,
  };
  return { io, out, err, json };
}

interface Fake {
  published: { event: UnsignedEvent; relayUrls: string[] }[];
  context: StandaloneContext;
}

function makeStandalone(identity = OWNER): Fake {
  const published: Fake['published'] = [];
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFeePerByte: 10n, eventFee: 5n }),
    uploadGitObject: async () => {
      throw new Error('maintainers never uploads objects');
    },
    publishEvent: async (event, relayUrls) => {
      published.push({ event, relayUrls });
      return { eventId: PUBLISHED_ID, feePaid: 5n };
    },
  };
  return {
    published,
    context: {
      ownerPubkey: identity,
      identitySource: 'dotenv',
      identitySourceLabel: '/repo/.env',
      publisher,
      defaultRelayUrls: [RELAY],
      fetchRemote: async () => {
        throw new Error('maintainers uses fetchRemoteState, not fetchRemote');
      },
      stop: async () => undefined,
    },
  };
}

function announcement(
  owner: string,
  maintainers: string[],
  overrides: { name?: string; description?: string } = {}
): NostrEvent {
  return {
    id: '30'.repeat(32),
    pubkey: owner,
    created_at: 1000,
    kind: 30617,
    tags: [
      ['d', REPO],
      ['name', overrides.name ?? 'Demo Repo'],
      ['description', overrides.description ?? 'A demo'],
      ...(maintainers.length > 0 ? [['maintainers', ...maintainers]] : []),
    ],
    content: '',
    sig: '0'.repeat(128),
  };
}

function makeDeps(
  rec: Recorder,
  fake: Fake,
  remoteEvents: NostrEvent[]
): EventCommandDeps {
  return {
    io: rec.io,
    env: {},
    cwd: '/nonexistent-not-a-repo',
    loadStandalone: async () => fake.context,
    webSocketFactory: makeMockRelayFactory(
      (filter) => filterEvents(remoteEvents, filter),
      'object'
    ),
  };
}

const ADDR = ['--repo-id', REPO, '--owner', OWNER, '--relay', RELAY];

describe('rig maintainers list (free)', () => {
  it('prints the owner + declared maintainers', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['list', ...ADDR, '--json'],
      makeDeps(io, fake, [announcement(OWNER, [M1])])
    );
    expect(code).toBe(0);
    expect(io.json[0]).toMatchObject({
      command: 'maintainers list',
      owner: OWNER,
      maintainers: [M1],
      announced: true,
    });
    expect(fake.published).toHaveLength(0); // free — nothing published
  });

  it('reports owner-only when there is no announcement', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['list', ...ADDR, '--json'],
      makeDeps(io, fake, [])
    );
    expect(code).toBe(0);
    expect(io.json[0]).toMatchObject({ announced: false, maintainers: [] });
  });
});

describe('rig maintainers add/remove (paid, owner-only)', () => {
  it('add republishes the 30617 with the new maintainer, preserving metadata', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [
        announcement(OWNER, [], { name: 'Keep Me', description: 'Keep this' }),
      ])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const { event, relayUrls } = fake.published[0]!;
    expect(event.kind).toBe(30617);
    expect(parseMaintainers(event.tags)).toEqual([M1]);
    // name/description preserved from the existing announcement.
    expect(event.tags).toContainEqual(['name', 'Keep Me']);
    expect(event.tags).toContainEqual(['description', 'Keep this']);
    expect(relayUrls).toEqual([RELAY]);
  });

  it('remove republishes the 30617 without the removed maintainer', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['remove', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [M1, M2])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    expect(parseMaintainers(fake.published[0]!.event.tags)).toEqual([M2]);
  });

  it('add is a no-op (nothing published) when already a maintainer', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [M1])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('already a maintainer');
  });

  it('remove is a no-op when the pubkey is not a maintainer', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['remove', M1, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [M2])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('not a declared maintainer');
  });

  it('REFUSES a non-owner republish (only the owner is authoritative, #287)', async () => {
    const io = makeIo();
    // The standalone identity is M1, but the repo owner (--owner) is OWNER.
    const fake = makeStandalone(M1);
    const code = await runMaintainers(
      ['add', M2, ...ADDR, '--yes'],
      makeDeps(io, fake, [announcement(OWNER, [])])
    );
    expect(code).toBe(1);
    expect(fake.published).toHaveLength(0);
    expect(io.err.join('\n')).toContain('only the repo owner');
  });

  it('estimate only: --json without --yes publishes nothing', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    const code = await runMaintainers(
      ['add', M1, ...ADDR, '--json'],
      makeDeps(io, fake, [announcement(OWNER, [])])
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(0);
    expect(io.json[0]).toMatchObject({
      command: 'maintainers add',
      executed: false,
      maintainers: [M1],
    });
  });

  it('validates the pubkey and subcommand (exit 2)', async () => {
    const io = makeIo();
    const fake = makeStandalone();
    expect(
      await runMaintainers(['add', 'nothex', ...ADDR], makeDeps(io, fake, []))
    ).toBe(2);
    expect(
      await runMaintainers(['bogus'], makeDeps(makeIo(), fake, []))
    ).toBe(2);
    expect(fake.published).toHaveLength(0);
  });
});
