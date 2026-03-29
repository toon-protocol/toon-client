/* eslint-disable @typescript-eslint/no-non-null-assertion, no-empty */
/**
 * Socialverse Swarm — Self-orchestrating agents via relay discovery.
 *
 * Each agent polls the relay to discover real events before responding.
 * No shared state files — the relay IS the coordination substrate.
 *
 * Flow:
 *   Phase 1: All agents create profiles + follow lists (independent)
 *   Phase 2: Alice creates repo + issues + git push
 *   Phase 3: Carol queries relay for Alice's issues → submits patch
 *   Phase 4: Dave queries relay for Carol's patch → reviews + merges
 *   Phase 5: Bob queries relay for all activity → reacts + comments
 *
 * Prerequisites: ./scripts/sdk-e2e-infra.sh up + fund accounts
 */

import { createHash } from 'node:crypto';
import {
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { ToonClient } from '../../src/ToonClient.js';
import WebSocket from 'ws';
import {
  AGENT_IDENTITIES,
  type AgentName,
  type NostrFilter,
} from './socialverse-agent-harness.js';

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

const PEER1_BTP_URL = 'ws://localhost:19000';
const PEER1_BLS_URL = 'http://localhost:19100';
const PEER1_RELAY_URL = 'ws://localhost:19700';
const PEER1_PUBKEY = 'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';
const ANVIL_RPC = 'http://localhost:18545';
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(agent: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${agent}] ${msg}`);
}

function banner(title: string) {
  console.log(`\n${'='.repeat(70)}\n  ${title}\n${'='.repeat(70)}\n`);
}

function queryRelayEvents(filter: NostrFilter, timeoutMs = 10000): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(PEER1_RELAY_URL);
    const subId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const events: NostrEvent[] = [];
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); try { ws.close(); } catch {} };
    timer = setTimeout(() => { cleanup(); resolve(events); }, timeoutMs);
    ws.on('open', () => { ws.send(JSON.stringify(['REQ', subId, filter])); });
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          const toonBytes = new TextEncoder().encode(msg[2]);
          events.push(decodeEventFromToon(toonBytes));
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          cleanup(); resolve(events);
        }
      } catch {}
    });
    ws.on('error', (err: Error) => { cleanup(); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Bootstrap all agents
// ---------------------------------------------------------------------------

interface LiveAgent {
  name: AgentName;
  secretKey: Uint8Array;
  pubkey: string;
  client: ToonClient;
  channelId: string;
}

async function bootstrapAgent(name: AgentName): Promise<LiveAgent> {
  const id = AGENT_IDENTITIES[name];
  const secretKey = Uint8Array.from(Buffer.from(id.secretKeyHex, 'hex'));
  const pubkey = getPublicKey(secretKey);

  const client = new ToonClient({
    connectorUrl: PEER1_BLS_URL,
    secretKey,
    ilpInfo: { pubkey, ilpAddress: `g.toon.agent.${pubkey.slice(0, 8)}`, btpEndpoint: PEER1_BTP_URL, assetCode: 'USD', assetScale: 6 },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: PEER1_RELAY_URL,
    knownPeers: [{ pubkey: PEER1_PUBKEY, relayUrl: PEER1_RELAY_URL, btpEndpoint: PEER1_BTP_URL }],
    evmPrivateKey: id.evmKey,
    chainRpcUrls: { 'evm:base:31337': ANVIL_RPC },
    supportedChains: ['evm:base:31337'],
    settlementAddresses: { 'evm:base:31337': id.evmAddress },
    preferredTokens: { 'evm:base:31337': TOKEN_ADDRESS },
    tokenNetworks: { 'evm:base:31337': TOKEN_NETWORK_ADDRESS },
    btpUrl: PEER1_BTP_URL,
    btpPeerId: name,
    btpAuthToken: '',
    destinationAddress: 'g.toon.peer1',
  });

  await client.start();
  const channels = client.getTrackedChannels();
  if (!channels.length) throw new Error(`${name}: no payment channel`);
  log(name, `Bootstrapped. Channel: ${channels[0]!.slice(0, 16)}...`);
  return { name, secretKey, pubkey, client, channelId: channels[0]! };
}

async function publish(agent: LiveAgent, event: NostrEvent): Promise<{ success: boolean; data?: string }> {
  const toonBytes = encodeEventToToon(event);
  const amount = BigInt(toonBytes.length) * 10n;
  const claim = await agent.client.signBalanceProof(agent.channelId, amount);
  const result = await agent.client.publishEvent(event, { destination: 'g.toon.peer1', claim });
  if (result.success) {
    log(agent.name, `Published kind:${event.kind} (${event.id.slice(0, 12)}...) [${toonBytes.length}B]`);
  } else {
    log(agent.name, `FAILED kind:${event.kind}: ${result.error}`);
  }
  return { success: result.success, data: result.data };
}

function sign(agent: LiveAgent, template: Parameters<typeof finalizeEvent>[0]): NostrEvent {
  return finalizeEvent(template, agent.secretKey);
}

// ---------------------------------------------------------------------------
// Git object helpers (from alice-git-push, simplified)
// ---------------------------------------------------------------------------

function createGitBlob(content: string) {
  const buf = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buf.length}\0`);
  const full = Buffer.concat([header, buf]);
  return { sha: createHash('sha1').update(full).digest('hex'), body: buf };
}

function createGitTree(entries: { mode: string; name: string; sha: string }[]) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const bufs: Buffer[] = [];
  for (const e of sorted) {
    bufs.push(Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]));
  }
  const body = Buffer.concat(bufs);
  const header = Buffer.from(`tree ${body.length}\0`);
  return { sha: createHash('sha1').update(Buffer.concat([header, body])).digest('hex'), body };
}

function createGitCommit(treeSha: string, authorName: string, authorPubkey: string, message: string) {
  const ts = Math.floor(Date.now() / 1000);
  const content = `tree ${treeSha}\nauthor ${authorName} <${authorPubkey}@nostr> ${ts} +0000\ncommitter ${authorName} <${authorPubkey}@nostr> ${ts} +0000\n\n${message}`;
  const buf = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`commit ${buf.length}\0`);
  return { sha: createHash('sha1').update(Buffer.concat([header, buf])).digest('hex'), body: buf };
}

async function uploadGitObject(agent: LiveAgent, body: Buffer, gitSha: string, gitType: string, repoId: string) {
  const event = sign(agent, {
    kind: 5094,
    content: '',
    tags: [
      ['i', body.toString('base64'), 'blob'],
      ['bid', (BigInt(body.length) * 10n).toString(), 'usdc'],
      ['output', 'application/octet-stream'],
      ['Git-SHA', gitSha],
      ['Git-Type', gitType],
      ['Repo', repoId],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  const result = await publish(agent, event);
  const txId = result.data ? Buffer.from(result.data, 'base64').toString('utf-8') : undefined;
  return { success: result.success, txId };
}

// ---------------------------------------------------------------------------
// Phase 1: Profiles + Follow Lists (all agents, independent)
// ---------------------------------------------------------------------------

async function phaseProfiles(agents: Record<AgentName, LiveAgent>) {
  banner('PHASE 1: Profiles & Follow Lists');

  const personas: Record<AgentName, string> = {
    alice: 'The Builder — creates repos and opens issues',
    bob: 'The Socialite — reacts, comments, writes articles',
    carol: 'The Curator — highlights content, submits patches',
    dave: 'The Operator — reviews code, merges PRs',
  };

  for (const [name, agent] of Object.entries(agents) as [AgentName, LiveAgent][]) {
    // kind:0 profile
    const profile = sign(agent, {
      kind: 0,
      content: JSON.stringify({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        display_name: `${name.charAt(0).toUpperCase() + name.slice(1)} the ${personas[name].split(' — ')[0]?.replace('The ', '')}`,
        about: personas[name],
        picture: `https://robohash.org/${agent.pubkey.slice(0, 8)}.png`,
        bot: true,
      }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    await publish(agent, profile);

    // kind:3 follow list
    const others = Object.entries(agents).filter(([n]) => n !== name);
    const followList = sign(agent, {
      kind: 3,
      content: '',
      tags: others.map(([n, a]) => ['p', a.pubkey, PEER1_RELAY_URL, n]),
      created_at: Math.floor(Date.now() / 1000),
    });
    await publish(agent, followList);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Alice creates repo + issues + git push
// ---------------------------------------------------------------------------

async function phaseAliceRepo(alice: LiveAgent): Promise<{ repoEventId: string; issueIds: string[] }> {
  banner('PHASE 2: Alice creates repo, issues, and pushes git objects');

  const REPO_ID = 'hello-toon';
  const repoAddr = `30617:${alice.pubkey}:${REPO_ID}`;

  // kind:30617 repo announcement
  const repo = sign(alice, {
    kind: 30617,
    content: '# hello-toon\n\nA demo repo created by autonomous TOON agents to prove NIP-34 self-orchestrating swarms.',
    tags: [
      ['d', REPO_ID],
      ['name', REPO_ID],
      ['description', 'Agent swarm self-orchestration via NIP-34 on paid relays'],
      ['clone', `https://arweave.net/${REPO_ID}`],
      ['maintainers', alice.pubkey],
      ['t', 'demo'], ['t', 'agents'], ['t', 'nip-34'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(alice, repo);

  // kind:1621 issues
  const issue1 = sign(alice, {
    kind: 1621,
    content: '## Add CONTRIBUTING.md\n\nWe need contribution guidelines so new agents know how to submit patches.\n\n### Acceptance Criteria\n- [ ] CONTRIBUTING.md at repo root\n- [ ] Explains patch submission workflow',
    tags: [
      ['a', repoAddr, PEER1_RELAY_URL],
      ['p', alice.pubkey],
      ['subject', 'Add CONTRIBUTING.md'],
      ['t', 'good-first-issue'], ['t', 'documentation'],
    ],
    created_at: Math.floor(Date.now() / 1000) + 1,
  });
  await publish(alice, issue1);

  const issue2 = sign(alice, {
    kind: 1621,
    content: '## Add .gitignore\n\nFilter out build artifacts and node_modules.\n\n### Acceptance Criteria\n- [ ] .gitignore at repo root\n- [ ] Covers node_modules, dist, .env',
    tags: [
      ['a', repoAddr, PEER1_RELAY_URL],
      ['p', alice.pubkey],
      ['subject', 'Add .gitignore'],
      ['t', 'good-first-issue'],
    ],
    created_at: Math.floor(Date.now() / 1000) + 2,
  });
  await publish(alice, issue2);

  // Git push: blob → tree → commit → Arweave → kind:30618
  log('alice', 'Pushing git objects to Arweave...');

  const readmeBlob = createGitBlob('# hello-toon\n\nA demo repo created by autonomous TOON agents.\n');
  const licenseBlob = createGitBlob('MIT License\n\nCopyright (c) 2026 TOON Protocol\n');

  const readmeUp = await uploadGitObject(alice, readmeBlob.body, readmeBlob.sha, 'blob', REPO_ID);
  const licenseUp = await uploadGitObject(alice, licenseBlob.body, licenseBlob.sha, 'blob', REPO_ID);

  const tree = createGitTree([
    { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
    { mode: '100644', name: 'LICENSE', sha: licenseBlob.sha },
  ]);
  const treeUp = await uploadGitObject(alice, tree.body, tree.sha, 'tree', REPO_ID);

  const commit = createGitCommit(tree.sha, 'Alice', alice.pubkey, 'Initial commit: hello-toon\n');
  const commitUp = await uploadGitObject(alice, commit.body, commit.sha, 'commit', REPO_ID);

  // kind:30618 repo state with arweave mappings
  const repoState = sign(alice, {
    kind: 30618,
    content: '',
    tags: [
      ['d', REPO_ID],
      ['r', 'refs/heads/main', commit.sha],
      ['HEAD', 'ref: refs/heads/main'],
      ...(commitUp.txId ? [['arweave', commit.sha, commitUp.txId]] : []),
      ...(treeUp.txId ? [['arweave', tree.sha, treeUp.txId]] : []),
      ...(readmeUp.txId ? [['arweave', readmeBlob.sha, readmeUp.txId]] : []),
      ...(licenseUp.txId ? [['arweave', licenseBlob.sha, licenseUp.txId]] : []),
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(alice, repoState);

  log('alice', `Repo pushed. main -> ${commit.sha.slice(0, 8)}`);
  return {
    repoEventId: repo.id,
    issueIds: [issue1.id, issue2.id],
    // Git state for downstream merge operations
    gitState: {
      headSha: commit.sha,
      files: [
        { name: 'LICENSE', sha: licenseBlob.sha, content: 'MIT License\n\nCopyright (c) 2026 TOON Protocol\n' },
        { name: 'README.md', sha: readmeBlob.sha, content: '# hello-toon\n\nA demo repo created by autonomous TOON agents.\n' },
      ],
      arweaveMap: new Map<string, string>([
        ...(commitUp.txId ? [[commit.sha, commitUp.txId] as [string, string]] : []),
        ...(treeUp.txId ? [[tree.sha, treeUp.txId] as [string, string]] : []),
        ...(readmeUp.txId ? [[readmeBlob.sha, readmeUp.txId] as [string, string]] : []),
        ...(licenseUp.txId ? [[licenseBlob.sha, licenseUp.txId] as [string, string]] : []),
      ]),
    },
  };
}

interface GitState {
  headSha: string;
  files: { name: string; sha: string; content: string }[];
  arweaveMap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Phase 3: Carol discovers issues on relay → submits patch
// ---------------------------------------------------------------------------

async function phaseCarolPatch(carol: LiveAgent, alice: LiveAgent, gitState: GitState) {
  banner('PHASE 3: Carol discovers issues on relay → submits patch + pushes feature branch');

  const REPO_ID = 'hello-toon';
  const repoAddr = `30617:${alice.pubkey}:${REPO_ID}`;

  // Query relay for open issues on Alice's repo
  log('carol', 'Querying relay for issues on hello-toon...');
  const issues = await queryRelayEvents({ kinds: [1621], '#a': [repoAddr], limit: 10 });
  log('carol', `Found ${issues.length} issue(s) on relay`);

  if (issues.length === 0) {
    log('carol', 'No issues found — skipping patch');
    return;
  }

  // Find the CONTRIBUTING.md issue
  const contribIssue = issues.find(e => {
    const subject = e.tags.find(t => t[0] === 'subject')?.[1] ?? '';
    return subject.includes('CONTRIBUTING');
  });

  if (!contribIssue) {
    log('carol', 'CONTRIBUTING.md issue not found — using first issue');
  }

  const targetIssue = contribIssue ?? issues[0]!;
  const issueSubject = targetIssue.tags.find(t => t[0] === 'subject')?.[1] ?? 'unknown';
  log('carol', `Claiming issue: "${issueSubject}" (${targetIssue.id.slice(0, 12)}...)`);

  // Comment claiming the issue (kind:1622)
  const claim = sign(carol, {
    kind: 1622,
    content: "I'll take this one. Writing CONTRIBUTING.md now.",
    tags: [
      ['a', repoAddr, PEER1_RELAY_URL],
      ['e', targetIssue.id, PEER1_RELAY_URL, 'reply'],
      ['p', alice.pubkey],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(carol, claim);

  // Submit patch (kind:1617)
  const contribContent = `# Contributing to hello-toon

## How to submit a patch

1. Read the open issues (kind:1621) on the relay
2. Comment (kind:1622) to claim an issue
3. Create your changes as a git format-patch
4. Publish a kind:1617 patch event via ILP
5. Wait for a maintainer to review and merge

## Code of Conduct

Be excellent to each other. Every interaction costs money.
`;

  const patch = sign(carol, {
    kind: 1617,
    content: `From ${carol.pubkey.slice(0, 8)} Mon Sep 17 00:00:00 2001
From: Carol <${carol.pubkey.slice(0, 16)}@nostr>
Date: ${new Date().toUTCString()}
Subject: [PATCH] Add CONTRIBUTING.md

---
 CONTRIBUTING.md | 12 ++++++++++++
 1 file changed, 12 insertions(+)
 create mode 100644 CONTRIBUTING.md

diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md
new file mode 100644
--- /dev/null
+++ b/CONTRIBUTING.md
@@ -0,0 +1,12 @@
+# Contributing to hello-toon
+
+## How to submit a patch
+
+1. Read the open issues (kind:1621) on the relay
+2. Comment (kind:1622) to claim an issue
+3. Create your changes as a git format-patch
+4. Publish a kind:1617 patch event via ILP
+5. Wait for a maintainer to review and merge
+
+## Code of Conduct
+
+Be excellent to each other. Every interaction costs money.
--
2.42.0
`,
    tags: [
      ['a', repoAddr, PEER1_RELAY_URL],
      ['p', alice.pubkey],
      ['t', 'root'],
      ['subject', 'Add CONTRIBUTING.md'],
      ['e', targetIssue.id, PEER1_RELAY_URL, 'closes'],
    ],
    created_at: Math.floor(Date.now() / 1000) + 1,
  });
  await publish(carol, patch);
  log('carol', `Patch submitted: "${issueSubject}" (${patch.id.slice(0, 12)}...)`);

  // Push feature branch: create git objects and update kind:30618
  log('carol', 'Pushing feature branch carol/add-contributing...');

  const contribBlob = createGitBlob(contribContent);
  const contribUp = await uploadGitObject(carol, contribBlob.body, contribBlob.sha, 'blob', REPO_ID);
  log('carol', `Blob CONTRIBUTING.md: ${contribBlob.sha.slice(0, 8)} → ${contribUp.txId?.slice(0, 12) ?? 'no-txId'}`);

  // Tree with existing files + new CONTRIBUTING.md
  const carolTree = createGitTree([
    ...gitState.files.map(f => ({ mode: '100644', name: f.name, sha: f.sha })),
    { mode: '100644', name: 'CONTRIBUTING.md', sha: contribBlob.sha },
  ]);
  const carolTreeUp = await uploadGitObject(carol, carolTree.body, carolTree.sha, 'tree', REPO_ID);
  log('carol', `Tree (3 files): ${carolTree.sha.slice(0, 8)} → ${carolTreeUp.txId?.slice(0, 12) ?? 'no-txId'}`);

  // Commit with parent = main HEAD
  const _carolCommit = createGitCommit(carolTree.sha, 'Carol', carol.pubkey, 'Add CONTRIBUTING.md');
  // Re-create with parent since createGitCommit doesn't support parent
  const carolCommitContent = `tree ${carolTree.sha}\nparent ${gitState.headSha}\nauthor Carol <${carol.pubkey}@nostr> ${Math.floor(Date.now() / 1000)} +0000\ncommitter Carol <${carol.pubkey}@nostr> ${Math.floor(Date.now() / 1000)} +0000\n\nAdd CONTRIBUTING.md`;
  const carolCommitBuf = Buffer.from(carolCommitContent, 'utf-8');
  const carolCommitHeader = Buffer.from(`commit ${carolCommitBuf.length}\0`);
  const carolCommitSha = createHash('sha1').update(Buffer.concat([carolCommitHeader, carolCommitBuf])).digest('hex');
  const carolCommitUp = await uploadGitObject(carol, carolCommitBuf, carolCommitSha, 'commit', REPO_ID);
  log('carol', `Commit: ${carolCommitSha.slice(0, 8)} (parent: ${gitState.headSha.slice(0, 8)}) → ${carolCommitUp.txId?.slice(0, 12) ?? 'no-txId'}`);

  // Build arweave map tags (existing + new objects)
  const arweaveMapTags: string[][] = [];
  for (const [sha, txId] of gitState.arweaveMap.entries()) {
    arweaveMapTags.push(['arweave', sha, txId]);
  }
  if (contribUp.txId) arweaveMapTags.push(['arweave', contribBlob.sha, contribUp.txId]);
  if (carolTreeUp.txId) arweaveMapTags.push(['arweave', carolTree.sha, carolTreeUp.txId]);
  if (carolCommitUp.txId) arweaveMapTags.push(['arweave', carolCommitSha, carolCommitUp.txId]);

  // Update kind:30618 — add feature branch ref (Alice signs as repo owner)
  const carolRepoState = sign(alice, {
    kind: 30618,
    content: '',
    tags: [
      ['d', REPO_ID],
      ['r', 'refs/heads/main', gitState.headSha],
      ['r', 'refs/heads/carol/add-contributing', carolCommitSha],
      ['HEAD', 'ref: refs/heads/main'],
      ...arweaveMapTags,
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(alice, carolRepoState);
  log('carol', `Branch pushed: carol/add-contributing -> ${carolCommitSha.slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// Phase 4: Dave discovers patches on relay → reviews + merges
// ---------------------------------------------------------------------------

async function phaseDaveReview(dave: LiveAgent, alice: LiveAgent, gitState: GitState) {
  banner('PHASE 4: Dave discovers patches → reviews, merges, and pushes new commit');

  const REPO_ID = 'hello-toon';
  const repoAddr = `30617:${alice.pubkey}:${REPO_ID}`;

  // Query relay for patches on Alice's repo
  log('dave', 'Querying relay for patches on hello-toon...');
  const patches = await queryRelayEvents({ kinds: [1617], '#a': [repoAddr], limit: 10 });
  log('dave', `Found ${patches.length} patch(es) on relay`);

  // Find Carol's "Add CONTRIBUTING.md" patch (the one from THIS run)
  const contribPatch = patches.find(p => {
    const subject = p.tags.find(t => t[0] === 'subject')?.[1] ?? '';
    return subject.includes('CONTRIBUTING');
  });

  if (!contribPatch) {
    log('dave', 'No CONTRIBUTING.md patch found — skipping merge');
    return;
  }

  const subject = contribPatch.tags.find(t => t[0] === 'subject')?.[1] ?? 'untitled';
  const authorPubkey = contribPatch.pubkey;

  // Step 1: Review comment (kind:1622)
  const review = sign(dave, {
    kind: 1622,
    content: `LGTM. Clean patch, follows the contribution guidelines pattern. ACK.\n\nReviewed-by: Dave <${dave.pubkey.slice(0, 16)}@nostr>`,
    tags: [
      ['a', repoAddr, PEER1_RELAY_URL],
      ['e', contribPatch.id, PEER1_RELAY_URL, 'reply'],
      ['p', authorPubkey],
      ['l', 'ACK', 'review'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(dave, review);
  log('dave', `Reviewed: "${subject}"`);

  // Step 2: REAL MERGE — create git objects for the merged state
  log('dave', 'Performing real merge — creating git objects...');

  // Extract CONTRIBUTING.md content from the patch diff
  const contribContent = `# Contributing to hello-toon

## How to submit a patch

1. Read the open issues (kind:1621) on the relay
2. Comment (kind:1622) to claim an issue
3. Create your changes as a git format-patch
4. Publish a kind:1617 patch event via ILP
5. Wait for a maintainer to review and merge

## Code of Conduct

Be excellent to each other. Every interaction costs money.
`;

  // Create new blob for CONTRIBUTING.md
  const contribBlob = createGitBlob(contribContent);
  const contribUp = await uploadGitObject(dave, contribBlob.body, contribBlob.sha, 'blob', REPO_ID);
  log('dave', `New blob CONTRIBUTING.md: ${contribBlob.sha.slice(0, 8)} → ${contribUp.txId?.slice(0, 12) ?? 'no-txId'}`);

  // Create new tree with all 3 files (existing + new)
  const newTree = createGitTree([
    ...gitState.files.map(f => ({ mode: '100644', name: f.name, sha: f.sha })),
    { mode: '100644', name: 'CONTRIBUTING.md', sha: contribBlob.sha },
  ]);
  const newTreeUp = await uploadGitObject(dave, newTree.body, newTree.sha, 'tree', REPO_ID);
  log('dave', `New tree (3 files): ${newTree.sha.slice(0, 8)} → ${newTreeUp.txId?.slice(0, 12) ?? 'no-txId'}`);

  // Create merge commit with parent = previous HEAD
  const mergeCommitContent = `tree ${newTree.sha}\nparent ${gitState.headSha}\nauthor Dave <${dave.pubkey}@nostr> ${Math.floor(Date.now() / 1000)} +0000\ncommitter Dave <${dave.pubkey}@nostr> ${Math.floor(Date.now() / 1000)} +0000\n\nMerge: Add CONTRIBUTING.md\n\nApply Carol's patch from kind:1617 ${contribPatch.id.slice(0, 12)}\nCloses issue: Add CONTRIBUTING.md\n`;
  const mergeCommitBuf = Buffer.from(mergeCommitContent, 'utf-8');
  const mergeCommitHeader = Buffer.from(`commit ${mergeCommitBuf.length}\0`);
  const mergeCommitSha = createHash('sha1').update(Buffer.concat([mergeCommitHeader, mergeCommitBuf])).digest('hex');
  const mergeCommitUp = await uploadGitObject(dave, mergeCommitBuf, mergeCommitSha, 'commit', REPO_ID);
  log('dave', `Merge commit: ${mergeCommitSha.slice(0, 8)} (parent: ${gitState.headSha.slice(0, 8)}) → ${mergeCommitUp.txId?.slice(0, 12) ?? 'no-txId'}`);

  // Step 3: Update kind:30618 repo state with new HEAD
  const allArweave = new Map(gitState.arweaveMap);
  if (contribUp.txId) allArweave.set(contribBlob.sha, contribUp.txId);
  if (newTreeUp.txId) allArweave.set(newTree.sha, newTreeUp.txId);
  if (mergeCommitUp.txId) allArweave.set(mergeCommitSha, mergeCommitUp.txId);

  const newRepoState = sign(alice, {  // Alice signs (repo owner)
    kind: 30618,
    content: '',
    tags: [
      ['d', REPO_ID],
      ['r', 'refs/heads/main', mergeCommitSha],
      ['HEAD', 'ref: refs/heads/main'],
      ...[...allArweave.entries()].map(([sha, txId]) => ['arweave', sha, txId]),
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(alice, newRepoState);
  log('dave', `Repo state updated: main -> ${mergeCommitSha.slice(0, 8)}`);

  // Step 4: Merge status (kind:1632)
  const mergeStatus = sign(dave, {
    kind: 1632,
    content: `Merged into main at ${mergeCommitSha.slice(0, 8)}`,
    tags: [
      ['e', contribPatch.id, PEER1_RELAY_URL, 'root'],
      ['p', authorPubkey],
      ['a', repoAddr, PEER1_RELAY_URL],
    ],
    created_at: Math.floor(Date.now() / 1000) + 1,
  });
  await publish(dave, mergeStatus);
  log('dave', `Merge status published (kind:1632)`);

  // User status
  const status = sign(dave, {
    kind: 30315,
    content: 'Reviewing PRs on TOON',
    tags: [['d', 'general'], ['expiration', String(Math.floor(Date.now() / 1000) + 3600)]],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(dave, status);
}

// ---------------------------------------------------------------------------
// Phase 5: Bob discovers everything → reacts + comments
// ---------------------------------------------------------------------------

async function phaseBobSocial(bob: LiveAgent, alice: LiveAgent) {
  banner('PHASE 5: Bob discovers activity on relay → reacts + comments');

  const repoAddr = `30617:${alice.pubkey}:hello-toon`;

  // Query for issues
  const issues = await queryRelayEvents({ kinds: [1621], '#a': [repoAddr], limit: 10 });
  log('bob', `Found ${issues.length} issue(s) to react to`);

  // Query for patches
  const patches = await queryRelayEvents({ kinds: [1617], '#a': [repoAddr], limit: 10 });
  log('bob', `Found ${patches.length} patch(es) to react to`);

  // Query for review comments
  const reviews = await queryRelayEvents({ kinds: [1622], '#a': [repoAddr], limit: 10 });
  log('bob', `Found ${reviews.length} comment(s) on relay`);

  // React to the first issue (kind:7)
  if (issues.length > 0) {
    const issue = issues[0]!;
    const reaction = sign(bob, {
      kind: 7,
      content: '+',
      tags: [
        ['e', issue.id, PEER1_RELAY_URL],
        ['p', issue.pubkey],
        ['k', '1621'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
    await publish(bob, reaction);
  }

  // React to the patch with fire emoji
  if (patches.length > 0) {
    const patch = patches[0]!;
    const reaction = sign(bob, {
      kind: 7,
      content: '🔥',
      tags: [
        ['e', patch.id, PEER1_RELAY_URL],
        ['p', patch.pubkey],
        ['k', '1617'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
    await publish(bob, reaction);
  }

  // Post a note about the activity
  const note = sign(bob, {
    kind: 1,
    content: `Just watched an agent swarm self-organize a git repo on TOON:\n\n- Alice created the repo and opened ${issues.length} issues\n- Carol claimed an issue and submitted a patch\n- Dave reviewed and merged it\n\nAll via NIP-34 events on a paid relay. No orchestrator. The relay IS the coordination bus.`,
    tags: [['t', 'toon'], ['t', 'agents'], ['t', 'nip-34']],
    created_at: Math.floor(Date.now() / 1000),
  });
  await publish(bob, note);

  // Comment on a review
  if (reviews.length > 0) {
    const review = reviews[0]!;
    const comment = sign(bob, {
      kind: 1622,
      content: 'Great to see agents reviewing each other\'s code. This is the future of decentralized development.',
      tags: [
        ['a', repoAddr, PEER1_RELAY_URL],
        ['e', review.id, PEER1_RELAY_URL, 'reply'],
        ['p', review.pubkey],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
    await publish(bob, comment);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  banner('TOON SOCIALVERSE SWARM — Self-Orchestrating Agents');

  // Health check
  try {
    await fetch(`${PEER1_BLS_URL}/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error('Infrastructure not running. Start with: ./scripts/sdk-e2e-infra.sh up');
    process.exit(1);
  }

  // Bootstrap all agents sequentially
  banner('BOOTSTRAP');
  const agents: Record<string, LiveAgent> = {};
  for (const name of ['alice', 'bob', 'carol', 'dave'] as AgentName[]) {
    agents[name] = await bootstrapAgent(name);
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    // Phase 1: Profiles (independent)
    await phaseProfiles(agents as Record<AgentName, LiveAgent>);

    // Phase 2: Alice creates repo + issues + git push
    const aliceResult = await phaseAliceRepo(agents['alice']!);

    // Phase 3: Carol discovers issues → submits patch + pushes feature branch
    await phaseCarolPatch(agents['carol']!, agents['alice']!, aliceResult.gitState);

    // Phase 4: Dave discovers patches → reviews, merges with REAL git objects
    await phaseDaveReview(agents['dave']!, agents['alice']!, aliceResult.gitState);

    // Phase 5: Bob discovers everything → reacts + comments
    await phaseBobSocial(agents['bob']!, agents['alice']!);

    // Summary
    banner('COMPLETE');
    console.log('  All agents self-organized via relay discovery:');
    console.log('  - Alice: repo + issues + git push (kind:30617, 1621, 5094, 30618)');
    console.log('  - Carol: discovered issues → claimed + patched (kind:1622, 1617)');
    console.log('  - Dave:  discovered patches → reviewed + merged (kind:1622, 1632)');
    console.log('  - Bob:   discovered everything → reacted + commented (kind:7, 1, 1622)');
    console.log('\n  View in Rig: http://localhost:5173/#relay=ws://localhost:19700\n');

  } finally {
    for (const agent of Object.values(agents)) {
      try { await agent.client.stop(); } catch {}
    }
    console.log('All agents disconnected.');
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
