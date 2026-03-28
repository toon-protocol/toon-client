/**
 * Dave — Socialverse AI Agent
 *
 * "The Operator" — runs infrastructure and reviews code.
 * Creates a profile, follow list, uploads a manifest via DVM,
 * posts a review comment on Alice's repo, sets a merged status,
 * and sets a user status.
 *
 * Every event structure is derived from the TOON skill files (cited in comments).
 */

import { runAgent } from './socialverse-agent-harness.js';

runAgent('dave', async (ctx) => {
  // -------------------------------------------------------------------------
  // (a) kind:0 — Profile Metadata
  //
  // Skill: social-identity/SKILL.md § "kind:0 -- Profile Metadata"
  //   - Core fields (NIP-01): name, about, picture
  //   - Extended fields (NIP-24): display_name, website, bot
  //   - Content is a JSON-serialized string
  //   - Replaceable event — latest kind:0 replaces previous
  // -------------------------------------------------------------------------
  const profileEvent = ctx.sign({
    kind: 0,
    content: JSON.stringify({
      name: 'dave',
      display_name: 'Dave',
      about: 'The Operator. Runs TOON infrastructure, reviews code, keeps the network humming.',
      picture: 'https://example.com/dave-avatar.png',
      website: 'https://example.com/dave',
      bot: true,
    }),
    tags: [
      // NIP-39 external identity claim (social-identity/SKILL.md § "NIP-39 External Identity Linking")
      ['i', 'github:dave-toon', 'https://gist.github.com/dave-toon/proof456'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(profileEvent);

  // -------------------------------------------------------------------------
  // (b) kind:3 — Follow List (Contacts)
  //
  // Skill: social-identity/SKILL.md § "kind:3 -- Follow List (Contacts)"
  //   - Replaceable event listing followed pubkeys via p tags
  //   - Tag format: ["p", "<pubkey-hex>", "<relay-url>", "<petname>"]
  //   - Content is typically empty
  // -------------------------------------------------------------------------
  const followListEvent = ctx.sign({
    kind: 3,
    content: '',
    tags: [
      ['p', ctx.peers['alice']!, ctx.relayUrl, 'alice'],
      ['p', ctx.peers['bob']!, ctx.relayUrl, 'bob'],
      ['p', ctx.peers['carol']!, ctx.relayUrl, 'carol'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(followListEvent);

  // -------------------------------------------------------------------------
  // (c) DVM Blob Upload — kind:5094 via ctx.publishBlob()
  //
  // Skill: dvm-protocol/SKILL.md § "DVM Protocol Model"
  //   - Job request (kind:5xxx) — client submits job specifying input data
  //   - kind:5094 = blob storage request
  //   - TOON prepaid model: the job request IS the payment
  //
  // Skill: git-collaboration/references/toon-extensions.md § "Arweave Blob Storage"
  //   - kind:5094 DVM requests carry the data as content
  //   - Free uploads up to 100KB in dev mode via TurboFactory.unauthenticated()
  //
  // The harness ctx.publishBlob() wraps buildBlobStorageRequest() from
  // @toon-protocol/core, which constructs the kind:5094 event internally.
  // -------------------------------------------------------------------------
  const manifest = {
    name: 'toon-infra-manifest',
    version: '0.1.0',
    services: ['relay', 'bls', 'faucet', 'anvil'],
    operator: ctx.pubkey,
    timestamp: Math.floor(Date.now() / 1000),
  };
  const manifestBlob = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  const blobResult = await ctx.publishBlob(manifestBlob, 'application/json');
  if (blobResult.success) {
    console.log(`[dave] Manifest uploaded to Arweave. txId: ${blobResult.txId ?? 'unknown'}`);
  }

  // -------------------------------------------------------------------------
  // (d) kind:1622 — Review Comment on Alice's Repo (ACK-ing a patch)
  //
  // Skill: git-collaboration/SKILL.md § "Comments (kind:1622)"
  //   - Anyone can comment on patches, PRs, or issues
  //   - Threading uses NIP-10 markers
  //
  // Ref: git-collaboration/references/kind-1622-comments.md
  //   - Required tags:
  //       e: ["e", "<parent-event-id>", "", "reply"] — parent event with NIP-10 reply marker
  //       p: ["p", "<parent-author-pubkey>"]
  //   - Optional tags:
  //       a: ["a", "30617:<pubkey>:<repo-id>"] — repository for context
  //
  // We reference Alice's "hello-toon" repo via the `a` tag.
  // The `e` tag points to a hypothetical patch event ID.
  // -------------------------------------------------------------------------
  const alicePubkey = ctx.peers['alice']!;
  const aliceRepoAddress = `30617:${alicePubkey}:hello-toon`;
  // Simulated patch event ID (would be a real event ID in production)
  const patchEventId = 'aabbccdd' + '0'.repeat(56);

  const reviewCommentEvent = ctx.sign({
    kind: 1622,
    content:
      'ACK. Reviewed the patch — the input validation logic is solid. ' +
      'The guard clause in `greet()` correctly handles empty strings and returns ' +
      'a default greeting. Clean diff, no unnecessary changes. Ready to merge.',
    tags: [
      // NIP-10 reply marker pointing to the patch event
      // (kind-1622-comments.md § "Required Tags")
      ['e', patchEventId, '', 'reply'],
      // Parent event author's pubkey (kind-1622-comments.md § "Required Tags")
      ['p', alicePubkey],
      // Repository context (kind-1622-comments.md § "Optional Tags")
      ['a', aliceRepoAddress],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(reviewCommentEvent);

  // -------------------------------------------------------------------------
  // (e) kind:1632 — Closed/Merged Status for a Patch
  //
  // Skill: git-collaboration/SKILL.md § "Status events (kind:1630-1633)"
  //   - Maintainers and authors set lifecycle status
  //   - kind:1632 = Closed
  //
  // Ref: git-collaboration/references/kind-1630-1633-status.md
  //   - Required tags:
  //       e: ["e", "<target-event-id>", "", "root"] — target event with root marker
  //   - Optional tags:
  //       p: ["p", "<target-author-pubkey>"]
  //       a: ["a", "30617:<pubkey>:<repo-id>"] — repository for context
  //       r: ["r", "<commit-hash>"] — related commit hash
  //
  // Note: The task asks for kind:1632 (merged status). Per the skill,
  // kind:1632 is actually "Closed" status. kind:1631 is "Applied/Merged".
  // Following the user's explicit request for kind:1632.
  // -------------------------------------------------------------------------
  const mergedStatusEvent = ctx.sign({
    kind: 1632,
    content: 'Patch applied and verified on staging. Closing as resolved.',
    tags: [
      // Target event with root marker (kind-1630-1633-status.md § "Required Tags")
      ['e', patchEventId, '', 'root'],
      // Target event author (kind-1630-1633-status.md § "Optional Tags")
      ['p', alicePubkey],
      // Repository context (kind-1630-1633-status.md § "Optional Tags")
      ['a', aliceRepoAddress],
      // Related commit hash (kind-1630-1633-status.md § "Optional Tags")
      ['r', 'abc123def456789012345678901234567890abcd'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(mergedStatusEvent);

  // -------------------------------------------------------------------------
  // (f) kind:30315 — User Status (NIP-38)
  //
  // Skill: user-statuses/SKILL.md § "kind:30315 -- User Status"
  //   - Parameterized replaceable event; d tag determines status type
  //   - Standard d tag values: "general", "music", or custom
  //   - Content field holds the status text
  //   - Optional tags: r (URL reference), expiration (NIP-40 auto-expiry)
  //
  // Ref: user-statuses/SKILL.md § "Optional Tags"
  //   - r tag: URL reference associated with the status
  //   - expiration tag: NIP-40 expiration timestamp
  // -------------------------------------------------------------------------
  const expirationTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  const userStatusEvent = ctx.sign({
    kind: 30315,
    content: 'Reviewing PRs on TOON',
    tags: [
      // d tag determines status type (user-statuses/SKILL.md § "Standard d Tag Values")
      ['d', 'general'],
      // URL reference to the activity (user-statuses/SKILL.md § "Optional Tags")
      ['r', 'https://toon.chat/repos'],
      // NIP-40 expiration — auto-clear after 1 hour (user-statuses/SKILL.md § "Optional Tags")
      ['expiration', expirationTime.toString()],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(userStatusEvent);

  console.log(`[dave] All events published successfully.`);
});
