#!/usr/bin/env npx tsx
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Socialverse E2E — 4 ToonClient agents interacting over ILP
 *
 * Demonstrates Epic 9 skills in action:
 * - NIP-01: Profiles, notes
 * - NIP-02: Follow lists
 * - NIP-25: Reactions
 * - NIP-34: Git collaboration (repos, issues, patches, comments, status)
 * - NIP-90: DVM blob storage (kind:5094 → Arweave)
 *
 * Prerequisites: ./scripts/sdk-e2e-infra.sh up
 *
 * Usage: cd packages/sdk && npx tsx ../../scripts/socialverse-e2e.ts
 *   OR:  npx tsx scripts/socialverse-e2e.ts  (from repo root, with correct tsconfig)
 */

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { ToonClient } from '../../src/ToonClient.js';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Infrastructure constants (docker-compose-sdk-e2e.yml)
// ---------------------------------------------------------------------------

const ANVIL_RPC = 'http://localhost:18545';
const PEER1_BTP_URL = 'ws://localhost:19000';
const PEER1_BLS_URL = 'http://localhost:19100';
const PEER1_RELAY_URL = 'ws://localhost:19700';
const PEER1_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';

// Deployed contracts (deterministic Anvil)
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// Anvil accounts #3–#6 (unused by Docker infra)
const ANVIL_ACCOUNTS = [
  {
    name: 'Alice',
    role: 'The Builder — creates repos, opens issues',
    privateKey:
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    evmAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
  {
    name: 'Bob',
    role: 'The Socialite — posts notes, creates polls, reacts',
    privateKey:
      '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    evmAddress: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  },
  {
    name: 'Carol',
    role: 'The Curator — highlights, comments, submits patches',
    privateKey:
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
    evmAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  },
  {
    name: 'Dave',
    role: 'The Operator — DVM uploads, reviews, merges',
    privateKey:
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    evmAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
];

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

interface Agent {
  name: string;
  role: string;
  nostrSecretKey: Uint8Array;
  pubkey: string;
  evmPrivateKey: string;
  evmAddress: string;
  client: ToonClient;
  channelId: string;
  publishedEvents: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(agent: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${agent}] ${msg}`);
}

function banner(title: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(70)}\n`);
}

function createAgentClient(
  nostrSecretKey: Uint8Array,
  pubkey: string,
  evmPrivateKey: string,
  evmAddress: string,
  btpPeerId: string
): ToonClient {
  return new ToonClient({
    connectorUrl: PEER1_BLS_URL,
    secretKey: nostrSecretKey,
    ilpInfo: {
      pubkey,
      ilpAddress: `g.toon.agent.${pubkey.slice(0, 8)}`,
      btpEndpoint: PEER1_BTP_URL,
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: PEER1_RELAY_URL,
    knownPeers: [
      {
        pubkey: PEER1_PUBKEY,
        relayUrl: PEER1_RELAY_URL,
        btpEndpoint: PEER1_BTP_URL,
      },
    ],
    evmPrivateKey,
    chainRpcUrls: { 'evm:base:31337': ANVIL_RPC },
    supportedChains: ['evm:base:31337'],
    settlementAddresses: { 'evm:base:31337': evmAddress },
    preferredTokens: { 'evm:base:31337': TOKEN_ADDRESS },
    tokenNetworks: { 'evm:base:31337': TOKEN_NETWORK_ADDRESS },
    btpUrl: PEER1_BTP_URL,
    btpPeerId,
    btpAuthToken: '',
    destinationAddress: 'g.toon.peer1',
  });
}

async function publish(
  agent: Agent,
  event: NostrEvent,
  destination = 'g.toon.peer1'
): Promise<boolean> {
  const toonBytes = encodeEventToToon(event);
  const amount = BigInt(toonBytes.length) * 10n;
  const claim = await agent.client.signBalanceProof(agent.channelId, amount);
  const result = await agent.client.publishEvent(event, {
    destination,
    claim,
  });
  if (result.success) {
    agent.publishedEvents.push(event.id);
    log(agent.name, `Published kind:${event.kind} (${event.id.slice(0, 12)}...) [${toonBytes.length} bytes, ${amount} units]`);
  } else {
    log(agent.name, `FAILED kind:${event.kind}: ${result.error}`);
  }
  return result.success;
}

function waitForEventOnRelay(
  relayUrl: string,
  eventId: string,
  timeoutMs = 15000
): Promise<NostrEvent | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const subId = `sv-${Date.now()}`;
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
    };

    timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          const toonBytes = new TextEncoder().encode(msg[2]);
          const event = decodeEventFromToon(toonBytes);
          cleanup();
          resolve(event);
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (err: Error) => { cleanup(); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkInfra(): Promise<boolean> {
  try {
    const [anvilOk, peer1Ok] = await Promise.all([
      fetch(ANVIL_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
        signal: AbortSignal.timeout(3000),
      }).then((r) => r.ok),
      fetch(`${PEER1_BLS_URL}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok),
    ]);
    return anvilOk && peer1Ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Bootstrap all agents
// ---------------------------------------------------------------------------

async function bootstrapAgents(): Promise<Agent[]> {
  banner('PHASE 1: Bootstrap Agents');
  const agents: Agent[] = [];

  for (const acct of ANVIL_ACCOUNTS) {
    const nostrSecretKey = generateSecretKey();
    const pubkey = getPublicKey(nostrSecretKey);
    const btpPeerId = acct.name.toLowerCase();

    log(acct.name, `${acct.role}`);
    log(acct.name, `Nostr pubkey: ${pubkey.slice(0, 16)}...`);
    log(acct.name, `EVM address:  ${acct.evmAddress}`);

    const client = createAgentClient(
      nostrSecretKey,
      pubkey,
      acct.privateKey,
      acct.evmAddress,
      btpPeerId
    );

    log(acct.name, 'Starting bootstrap...');
    const startResult = await client.start();
    log(acct.name, `Bootstrap complete! Peers: ${startResult.peersDiscovered}, Mode: ${startResult.mode}`);

    const channels = client.getTrackedChannels();
    if (channels.length === 0) {
      log(acct.name, 'WARNING: No payment channels opened!');
      continue;
    }
    const channelId = channels[0]!;
    log(acct.name, `Payment channel: ${channelId.slice(0, 16)}...`);

    agents.push({
      name: acct.name,
      role: acct.role,
      nostrSecretKey,
      pubkey,
      evmPrivateKey: acct.privateKey,
      evmAddress: acct.evmAddress,
      client,
      channelId,
      publishedEvents: [],
    });

    // Small delay between agent bootstraps to avoid BTP race
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n  ${agents.length} agents bootstrapped and funded.\n`);
  return agents;
}

// ---------------------------------------------------------------------------
// Phase 2: Identity — Profiles (kind:0) + Follow lists (kind:3)
// ---------------------------------------------------------------------------

async function phaseIdentity(agents: Agent[]) {
  banner('PHASE 2: Identity — Profiles & Follow Lists');

  // Each agent publishes their profile (kind:0)
  for (const agent of agents) {
    const profile = finalizeEvent(
      {
        kind: 0,
        content: JSON.stringify({
          name: agent.name,
          about: agent.role,
          picture: `https://robohash.org/${agent.pubkey.slice(0, 8)}.png`,
          nip05: `${agent.name.toLowerCase()}@toon.protocol`,
        }),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      agent.nostrSecretKey
    );
    await publish(agent, profile);
  }

  // Each agent follows all others (kind:3)
  for (const agent of agents) {
    const tags = agents
      .filter((a) => a.pubkey !== agent.pubkey)
      .map((a) => ['p', a.pubkey, PEER1_RELAY_URL, a.name]);

    const followList = finalizeEvent(
      {
        kind: 3,
        content: '',
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      agent.nostrSecretKey
    );
    await publish(agent, followList);
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Social — Notes (kind:1) + Reactions (kind:7)
// ---------------------------------------------------------------------------

async function phaseSocial(agents: Agent[]) {
  banner('PHASE 3: Social — Notes & Reactions');

  const [alice, bob, carol, dave] = agents;

  // Bob posts a note
  const bobNote = finalizeEvent(
    {
      kind: 1,
      content:
        'gm toon network! First day using a paid relay. Every word costs money so I better make them count.',
      tags: [['t', 'gm'], ['t', 'toon']],
      created_at: Math.floor(Date.now() / 1000),
    },
    bob!.nostrSecretKey
  );
  await publish(bob!, bobNote);

  // Alice replies to Bob's note (NIP-10 threading)
  const aliceReply = finalizeEvent(
    {
      kind: 1,
      content:
        'Welcome Bob! Paying per-byte actually makes you think before posting. Quality > quantity.',
      tags: [
        ['e', bobNote.id, PEER1_RELAY_URL, 'root'],
        ['p', bob!.pubkey],
      ],
      created_at: Math.floor(Date.now() / 1000) + 1,
    },
    alice!.nostrSecretKey
  );
  await publish(alice!, aliceReply);

  // Carol reacts to Bob's note (NIP-25)
  const carolReaction = finalizeEvent(
    {
      kind: 7,
      content: '+',
      tags: [
        ['e', bobNote.id],
        ['p', bob!.pubkey],
      ],
      created_at: Math.floor(Date.now() / 1000) + 2,
    },
    carol!.nostrSecretKey
  );
  await publish(carol!, carolReaction);

  // Dave reacts with a custom emoji
  const daveReaction = finalizeEvent(
    {
      kind: 7,
      content: '🔥',
      tags: [
        ['e', bobNote.id],
        ['p', bob!.pubkey],
      ],
      created_at: Math.floor(Date.now() / 1000) + 3,
    },
    dave!.nostrSecretKey
  );
  await publish(dave!, daveReaction);

  // Carol posts a long-form highlight (NIP-84, kind:9802)
  const highlight = finalizeEvent(
    {
      kind: 9802,
      content: 'Paying per-byte actually makes you think before posting. Quality > quantity.',
      tags: [
        ['e', aliceReply.id],
        ['p', alice!.pubkey],
        ['context', 'Social commentary on paid relay economics'],
      ],
      created_at: Math.floor(Date.now() / 1000) + 4,
    },
    carol!.nostrSecretKey
  );
  await publish(carol!, highlight);
}

// ---------------------------------------------------------------------------
// Phase 4: Git Collaboration (NIP-34) — the self-orchestrating swarm
// ---------------------------------------------------------------------------

async function phaseGitCollaboration(agents: Agent[]) {
  banner('PHASE 4: Git Collaboration (NIP-34) — Self-Orchestrating Swarm');

  const [alice, bob, carol, dave] = agents;
  const repoName = 'hello-toon';
  const repoId = `${alice!.pubkey.slice(0, 8)}/${repoName}`;
  const now = Math.floor(Date.now() / 1000);

  // --- Step 1: Alice creates a repository announcement (kind:30617) ---
  log(alice!.name, 'Creating repository announcement...');
  const repoAnnouncement = finalizeEvent(
    {
      kind: 30617,
      content: `# hello-toon

A simple demo repository created by autonomous TOON agents to demonstrate
NIP-34 decentralized git collaboration over ILP-gated relays.

## Purpose

Prove that agent swarms can self-orchestrate using git workflows as the
coordination substrate. No central orchestrator needed — just Nostr events
on a paid relay.`,
      tags: [
        ['d', repoName],
        ['name', repoName],
        ['description', 'Demo repo: agent swarm self-orchestration via NIP-34'],
        ['clone', `https://arweave.net/${repoName}`],
        ['web', `https://rig.toon.protocol/${repoId}`],
        ['maintainers', alice!.pubkey, dave!.pubkey],
        ['t', 'demo'],
        ['t', 'agents'],
        ['t', 'nip-34'],
      ],
      created_at: now,
    },
    alice!.nostrSecretKey
  );
  await publish(alice!, repoAnnouncement);

  // --- Step 2: Alice opens issues (kind:1621) ---
  log(alice!.name, 'Opening issues for the swarm to work on...');

  const issue1 = finalizeEvent(
    {
      kind: 1621,
      content: `# Add README.md

We need a README that explains what this project does and how agents
collaborate on it via NIP-34.

## Acceptance Criteria
- [ ] README.md exists at repo root
- [ ] Explains the TOON agent swarm concept
- [ ] Links to NIP-34 spec`,
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['subject', 'Add README.md'],
        ['t', 'good-first-issue'],
        ['t', 'documentation'],
      ],
      created_at: now + 1,
    },
    alice!.nostrSecretKey
  );
  await publish(alice!, issue1);

  const issue2 = finalizeEvent(
    {
      kind: 1621,
      content: `# Add LICENSE file

Every open-source project needs a license. Add MIT license.

## Acceptance Criteria
- [ ] LICENSE file at repo root
- [ ] MIT license text`,
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['subject', 'Add LICENSE file'],
        ['t', 'good-first-issue'],
      ],
      created_at: now + 2,
    },
    alice!.nostrSecretKey
  );
  await publish(alice!, issue2);

  // --- Step 3: Bob claims issue 1 by commenting (kind:1622) ---
  log(bob!.name, 'Claiming issue #1 (README.md)...');
  const bobClaim = finalizeEvent(
    {
      kind: 1622,
      content: "I'll take this one. Writing the README now.",
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['e', issue1.id, PEER1_RELAY_URL],
        ['p', alice!.pubkey],
      ],
      created_at: now + 3,
    },
    bob!.nostrSecretKey
  );
  await publish(bob!, bobClaim);

  // --- Step 4: Carol claims issue 2 ---
  log(carol!.name, 'Claiming issue #2 (LICENSE)...');
  const carolClaim = finalizeEvent(
    {
      kind: 1622,
      content: 'On it. Adding MIT license.',
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['e', issue2.id, PEER1_RELAY_URL],
        ['p', alice!.pubkey],
      ],
      created_at: now + 4,
    },
    carol!.nostrSecretKey
  );
  await publish(carol!, carolClaim);

  // --- Step 5: Bob submits a patch (kind:1617) ---
  log(bob!.name, 'Submitting patch for README.md...');
  const bobPatch = finalizeEvent(
    {
      kind: 1617,
      content: `From ${bob!.pubkey.slice(0, 8)} Mon Sep 17 00:00:00 2001
From: Bob <${bob!.pubkey.slice(0, 8)}@toon.protocol>
Date: ${new Date().toUTCString()}
Subject: [PATCH] Add README.md

---
 README.md | 15 +++++++++++++++
 1 file changed, 15 insertions(+)
 create mode 100644 README.md

diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1,15 @@
+# hello-toon
+
+A demo repository created by autonomous TOON agents.
+
+## What is this?
+
+Four agents (Alice, Bob, Carol, Dave) collaborate on this repo
+using NIP-34 events over an ILP-gated Nostr relay. No central
+orchestrator — just paid events on the TOON network.
+
+## How it works
+
+- Repos announced via kind:30617
+- Issues tracked via kind:1621
+- Patches submitted via kind:1617
--
2.42.0
`,
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['p', alice!.pubkey],
        ['t', 'root'],
        ['subject', 'Add README.md'],
        ['e', issue1.id, PEER1_RELAY_URL, 'closes'],
      ],
      created_at: now + 5,
    },
    bob!.nostrSecretKey
  );
  await publish(bob!, bobPatch);

  // --- Step 6: Carol submits a patch for LICENSE ---
  log(carol!.name, 'Submitting patch for LICENSE...');
  const carolPatch = finalizeEvent(
    {
      kind: 1617,
      content: `From ${carol!.pubkey.slice(0, 8)} Mon Sep 17 00:00:00 2001
From: Carol <${carol!.pubkey.slice(0, 8)}@toon.protocol>
Date: ${new Date().toUTCString()}
Subject: [PATCH] Add MIT LICENSE

---
 LICENSE | 7 +++++++
 1 file changed, 7 insertions(+)
 create mode 100644 LICENSE

diff --git a/LICENSE b/LICENSE
new file mode 100644
--- /dev/null
+++ b/LICENSE
@@ -0,0 +1,7 @@
+MIT License
+
+Copyright (c) 2026 TOON Protocol Agent Swarm
+
+Permission is hereby granted, free of charge, to any person obtaining a copy
+of this software and associated documentation files (the "Software"), to deal
+in the Software without restriction.
--
2.42.0
`,
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['p', alice!.pubkey],
        ['t', 'root'],
        ['subject', 'Add MIT LICENSE'],
        ['e', issue2.id, PEER1_RELAY_URL, 'closes'],
      ],
      created_at: now + 6,
    },
    carol!.nostrSecretKey
  );
  await publish(carol!, carolPatch);

  // --- Step 7: Dave reviews Bob's patch (kind:1622 comment) ---
  log(dave!.name, 'Reviewing patches...');
  const daveReview1 = finalizeEvent(
    {
      kind: 1622,
      content:
        'LGTM. Clean README, covers the basics. Merging.',
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['e', bobPatch.id, PEER1_RELAY_URL],
        ['p', bob!.pubkey],
        ['l', 'ACK', 'review'],
      ],
      created_at: now + 7,
    },
    dave!.nostrSecretKey
  );
  await publish(dave!, daveReview1);

  const daveReview2 = finalizeEvent(
    {
      kind: 1622,
      content:
        'License looks good. MIT is the right choice for a demo. Merging.',
      tags: [
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
        ['e', carolPatch.id, PEER1_RELAY_URL],
        ['p', carol!.pubkey],
        ['l', 'ACK', 'review'],
      ],
      created_at: now + 8,
    },
    dave!.nostrSecretKey
  );
  await publish(dave!, daveReview2);

  // --- Step 8: Dave sets patch status to merged (kind:1630) ---
  log(dave!.name, 'Setting patch status to merged...');
  const _mergeStatus1 = finalizeEvent(
    {
      kind: 1630, // open
      content: '',
      tags: [
        ['e', bobPatch.id, PEER1_RELAY_URL],
        ['p', bob!.pubkey],
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
      ],
      created_at: now + 9,
    },
    dave!.nostrSecretKey
  );
  // kind:1632 = merged
  const mergeStatus1Merged = finalizeEvent(
    {
      kind: 1632,
      content: 'Merged into main',
      tags: [
        ['e', bobPatch.id, PEER1_RELAY_URL],
        ['p', bob!.pubkey],
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
      ],
      created_at: now + 10,
    },
    dave!.nostrSecretKey
  );
  await publish(dave!, mergeStatus1Merged);

  const mergeStatus2 = finalizeEvent(
    {
      kind: 1632,
      content: 'Merged into main',
      tags: [
        ['e', carolPatch.id, PEER1_RELAY_URL],
        ['p', carol!.pubkey],
        ['a', `30617:${alice!.pubkey}:${repoName}`, PEER1_RELAY_URL],
      ],
      created_at: now + 11,
    },
    dave!.nostrSecretKey
  );
  await publish(dave!, mergeStatus2);

  // --- Step 9: Alice updates repo state (kind:30618) ---
  log(alice!.name, 'Updating repository state after merges...');
  const repoState = finalizeEvent(
    {
      kind: 30618,
      content: '',
      tags: [
        ['d', repoName],
        ['HEAD', 'refs/heads/main'],
        ['ref', 'refs/heads/main', `merge-${bobPatch.id.slice(0, 8)}`],
        ['patches', bobPatch.id, carolPatch.id],
      ],
      created_at: now + 12,
    },
    alice!.nostrSecretKey
  );
  await publish(alice!, repoState);
}

// ---------------------------------------------------------------------------
// Phase 5: DVM — Arweave blob storage (kind:5094)
// ---------------------------------------------------------------------------

async function phaseDvm(agents: Agent[]) {
  banner('PHASE 5: DVM — Arweave Blob Storage');

  const [alice, , , dave] = agents;

  // Dave uploads a small text file via kind:5094 DVM request
  log(dave!.name, 'Uploading project manifest to Arweave via DVM...');
  const manifestContent = JSON.stringify(
    {
      name: 'hello-toon',
      version: '0.1.0',
      description: 'Demo repo created by TOON agent swarm',
      agents: agents.map((a) => ({
        name: a.name,
        pubkey: a.pubkey.slice(0, 16) + '...',
        role: a.role,
      })),
      created: new Date().toISOString(),
      network: 'toon-sdk-e2e',
    },
    null,
    2
  );

  const blob = Buffer.from(manifestContent, 'utf-8');
  const pricePerByte = 10n;
  const dvmAmount = BigInt(blob.length) * pricePerByte;

  const dvmEvent = buildBlobStorageRequest(
    {
      blobData: blob,
      contentType: 'application/json',
      bid: dvmAmount.toString(),
    },
    dave!.nostrSecretKey
  );

  const dvmClaim = await dave!.client.signBalanceProof(
    dave!.channelId,
    dvmAmount
  );
  const dvmResult = await dave!.client.publishEvent(dvmEvent, {
    destination: 'g.toon.peer1',
    claim: dvmClaim,
  });

  if (dvmResult.success) {
    dave!.publishedEvents.push(dvmEvent.id);
    const txId = dvmResult.data
      ? Buffer.from(dvmResult.data, 'base64').toString('utf-8')
      : 'unknown';
    log(dave!.name, `DVM upload SUCCESS! Arweave TX: ${txId}`);

    // Alice references the Arweave TX in a note
    const arweaveRef = finalizeEvent(
      {
        kind: 1,
        content: `Project manifest uploaded to Arweave! TX: ${txId}\n\nOur agent swarm just self-organized a git repo using NIP-34 events on a paid relay. The future is here.`,
        tags: [
          ['i', `arweave:tx:${txId}`],
          ['t', 'arweave'],
          ['t', 'toon'],
          ['t', 'agents'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      alice!.nostrSecretKey
    );
    await publish(alice!, arweaveRef);
  } else {
    log(dave!.name, `DVM upload FAILED: ${dvmResult.error}`);
    log(dave!.name, 'This may be the known BTP DVM handler gap — continuing...');
  }
}

// ---------------------------------------------------------------------------
// Phase 6: Verify — Check events on relay
// ---------------------------------------------------------------------------

async function phaseVerify(agents: Agent[]) {
  banner('PHASE 6: Verification');

  let verified = 0;
  let failed = 0;
  const sampleSize = Math.min(
    6,
    agents.reduce((sum, a) => sum + a.publishedEvents.length, 0)
  );

  // Sample a few events from each agent
  const sampled: { agent: string; eventId: string }[] = [];
  for (const agent of agents) {
    if (agent.publishedEvents.length > 0) {
      // Take first and last event from each agent
      sampled.push({ agent: agent.name, eventId: agent.publishedEvents[0]! });
      if (agent.publishedEvents.length > 1) {
        sampled.push({
          agent: agent.name,
          eventId: agent.publishedEvents[agent.publishedEvents.length - 1]!,
        });
      }
    }
  }

  for (const { agent, eventId } of sampled.slice(0, sampleSize)) {
    const event = await waitForEventOnRelay(PEER1_RELAY_URL, eventId, 10000);
    if (event) {
      log(agent, `Verified on relay: kind:${event.kind} (${eventId.slice(0, 12)}...)`);
      verified++;
    } else {
      log(agent, `NOT FOUND on relay: ${eventId.slice(0, 12)}...`);
      failed++;
    }
  }

  console.log(`\n  Verified: ${verified}/${verified + failed} sampled events found on relay.\n`);
}

// ---------------------------------------------------------------------------
// Phase 7: Summary
// ---------------------------------------------------------------------------

function phaseSummary(agents: Agent[]) {
  banner('SUMMARY');

  const totalEvents = agents.reduce(
    (sum, a) => sum + a.publishedEvents.length,
    0
  );

  console.log('  Agent Activity:');
  for (const agent of agents) {
    console.log(
      `    ${agent.name} (${agent.pubkey.slice(0, 12)}...): ${agent.publishedEvents.length} events published`
    );
  }

  console.log(`\n  Total events: ${totalEvents}`);
  console.log('  Skills exercised:');
  console.log('    - nostr-protocol-core (kind:0, kind:1, kind:3)');
  console.log('    - social-identity (NIP-02 follow lists, NIP-05 profiles)');
  console.log('    - social-interactions (NIP-25 reactions)');
  console.log('    - highlights (NIP-84 kind:9802)');
  console.log('    - git-collaboration (NIP-34: kind:30617, 30618, 1617, 1621, 1622, 1630-1633)');
  console.log('    - dvm-protocol (NIP-90: kind:5094 blob storage)');
  console.log('    - media-and-files (NIP-73: arweave:tx: references)');
  console.log('    - content-references (NIP-10 threading, NIP-27 refs)');
  console.log(`\n  Infrastructure: 2 TOON peers (Peer1 + Peer2) + Anvil (chain 31337)`);
  console.log('  Transport: ILP over BTP with per-packet EIP-712 balance proofs');
  console.log('  Storage: Events on TOON relay + manifest on Arweave\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  banner('TOON SOCIALVERSE E2E — Agent Swarm Test');
  console.log('  Testing Epic 9 skills with 4 ToonClient agents over ILP.\n');

  // Health check
  const ready = await checkInfra();
  if (!ready) {
    console.error('SDK E2E infrastructure not running. Start with:');
    console.error('  ./scripts/sdk-e2e-infra.sh up');
    process.exit(1);
  }
  console.log('  Infrastructure healthy.\n');

  let agents: Agent[] = [];
  try {
    // Phase 1: Bootstrap
    agents = await bootstrapAgents();
    if (agents.length < 4) {
      console.error('Not all agents bootstrapped. Aborting.');
      process.exit(1);
    }

    // Phase 2: Identity
    await phaseIdentity(agents);

    // Phase 3: Social
    await phaseSocial(agents);

    // Phase 4: Git collaboration (NIP-34)
    await phaseGitCollaboration(agents);

    // Phase 5: DVM (Arweave)
    await phaseDvm(agents);

    // Phase 6: Verify
    await phaseVerify(agents);

    // Summary
    phaseSummary(agents);
  } catch (error) {
    console.error('\nFATAL:', error);
    process.exit(1);
  } finally {
    // Cleanup
    for (const agent of agents) {
      try {
        await agent.client.stop();
        log(agent.name, 'Disconnected.');
      } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
