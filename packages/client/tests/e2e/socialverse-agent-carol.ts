/**
 * Carol — "The Curator"
 *
 * Carol highlights and organizes content across the TOON network.
 * She curates passages, reviews git repos, and maintains organized pin lists.
 *
 * Skills referenced:
 *  - social-identity (kind:0, kind:3)
 *  - highlights (kind:9802, NIP-84)
 *  - git-collaboration (kind:1622, kind:1617, NIP-34)
 *  - lists-and-labels (kind:10001, NIP-51)
 *  - content-references (nostr: URI scheme, NIP-21/NIP-27)
 *  - nostr-protocol-core (event structure, TOON write model)
 */

import { runAgent, AGENT_IDENTITIES } from './socialverse-agent-harness.js';

await runAgent('carol', async (ctx) => {
  const now = Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------------------
  // (a) Kind:0 — Profile metadata
  // Skill: social-identity § "kind:0 -- Profile Metadata"
  //   Core fields (NIP-01): name, about, picture, nip05
  //   Extended fields (NIP-24): display_name, website, banner, bot
  // -------------------------------------------------------------------------
  const profileEvent = ctx.sign({
    kind: 0,
    created_at: now,
    tags: [],
    content: JSON.stringify({
      name: 'carol',
      display_name: 'Carol the Curator',
      about: 'I highlight the best passages and organize knowledge across the TOON network. Paid curation means every highlight is a deliberate act of endorsement.',
      picture: 'https://example.com/carol-avatar.png',
      website: 'https://carol.toon.example',
      bot: true,
    }),
  });
  await ctx.publish(profileEvent);
  console.log(`[carol] Published profile (kind:0)`);

  // -------------------------------------------------------------------------
  // (b) Kind:3 — Follow list (contacts)
  // Skill: social-identity § "kind:3 -- Follow List (Contacts)"
  //   Tag format: ["p", "<pubkey-hex>", "<relay-url>", "<petname>"]
  //   (relay and petname optional)
  // -------------------------------------------------------------------------
  const followListEvent = ctx.sign({
    kind: 3,
    created_at: now,
    tags: [
      // Follow alice, bob, dave — relay hint and petname per social-identity skill
      ['p', ctx.peers.alice, ctx.relayUrl, 'alice'],
      ['p', ctx.peers.bob, ctx.relayUrl, 'bob'],
      ['p', ctx.peers.dave, ctx.relayUrl, 'dave'],
    ],
    content: '',
  });
  await ctx.publish(followListEvent);
  console.log(`[carol] Published follow list (kind:3) — following alice, bob, dave`);

  // -------------------------------------------------------------------------
  // (c) Kind:9802 — Highlight (NIP-84)
  // Skill: highlights § "kind:9802 -- Highlight Event"
  //   content = exact highlighted passage
  //   Source reference tags (at least one required): a, e, or r tag
  //   Attribution tag: p tag for source author
  //   Context tag: surrounding text for context
  // Scenario: highlights/references/scenarios.md § Scenario 3 (web content)
  //   r tag for URL, p tag for author if they have a Nostr pubkey
  // -------------------------------------------------------------------------
  const highlightEvent = ctx.sign({
    kind: 9802,
    created_at: now,
    tags: [
      // r tag — URL source reference per highlights skill § "Source reference tags"
      ['r', 'https://toon.example/blog/paid-relays-and-quality'],
      // p tag — attribution to Bob who wrote about paid relays
      // Skill: highlights § "Attribution tag"
      ['p', ctx.peers.bob],
      // context tag — surrounding text per highlights skill § "Context tag"
      ['context', 'The economics of paid relays fundamentally change the incentive landscape. When every post costs real money, spam disappears and quality rises. Paid relays create a natural quality floor that free networks cannot replicate. This is the key insight behind TOON.'],
    ],
    // content = the exact highlighted passage per highlights skill § "Required content"
    content: 'Paid relays create a natural quality floor that free networks cannot replicate.',
  });
  await ctx.publish(highlightEvent);
  console.log(`[carol] Published highlight (kind:9802) — quote about paid relays`);

  // -------------------------------------------------------------------------
  // (d) Kind:1622 — Comment on Alice's repo (NIP-34)
  // Skill: git-collaboration § "Comments (kind:1622)"
  // Reference: git-collaboration/references/kind-1622-comments.md
  //   Required tags:
  //     e tag: ["e", "<parent-event-id>", "", "reply"] — NIP-10 reply marker
  //     p tag: ["p", "<parent-author-pubkey>"]
  //   Optional tags:
  //     a tag: ["a", "30617:<pubkey>:<repo-id>"] — repository context
  //   Content: markdown text of the comment
  //
  // We use a synthetic parent event ID since we're commenting on the repo
  // announcement itself. The a tag references Alice's repo per NIP-34.
  // -------------------------------------------------------------------------
  const alicePubkey = AGENT_IDENTITIES.alice.pubkey;
  // Synthetic event ID for Alice's repo announcement (would be real in production)
  const repoAnnouncementId = 'a'.repeat(64);

  const commentEvent = ctx.sign({
    kind: 1622,
    created_at: now,
    tags: [
      // e tag with NIP-10 reply marker per kind-1622-comments.md § "Required Tags"
      ['e', repoAnnouncementId, '', 'reply'],
      // p tag for parent author per kind-1622-comments.md § "Required Tags"
      ['p', alicePubkey],
      // a tag for repository context per kind-1622-comments.md § "Optional Tags"
      // Format: 30617:<pubkey>:<repo-id> per git-collaboration skill
      ['a', `30617:${alicePubkey}:hello-toon`],
    ],
    content: `Great project structure! The hello-toon repo has a clean separation of concerns. A few suggestions:

1. Consider adding a CONTRIBUTING.md to help new contributors get started
2. The README could benefit from a quick-start section
3. License file would clarify reuse terms

Happy to submit a patch for the CONTRIBUTING.md.`,
  });
  await ctx.publish(commentEvent);
  console.log(`[carol] Published comment (kind:1622) on Alice's hello-toon repo`);

  // -------------------------------------------------------------------------
  // (e) Kind:1617 — Patch for Alice's repo (NIP-34)
  // Skill: git-collaboration § "Patches (kind:1617)"
  // Reference: git-collaboration/references/kind-1617-patches.md
  //   Required tags:
  //     a tag: ["a", "30617:<pubkey>:<repo-id>"] — repository address
  //     r tag: ["r", "<earliest-unique-commit>"] — earliest unique commit
  //   Optional tags:
  //     p tag: maintainer to notify
  //     t tag: ["t", "root"] — first event in a patch series
  //     commit / parent-commit tags
  //   Content: output of git format-patch
  // -------------------------------------------------------------------------
  const patchContent = `From 1a2b3c4d5e6f Mon Sep 17 00:00:00 2001
From: Carol <carol@toon.example>
Date: Sat, 28 Mar 2026 12:00:00 +0000
Subject: [PATCH] Add CONTRIBUTING.md with contributor guidelines

---
 CONTRIBUTING.md | 25 +++++++++++++++++++++++++
 1 file changed, 25 insertions(+)
 create mode 100644 CONTRIBUTING.md

diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md
new file mode 100644
index 0000000..a1b2c3d
--- /dev/null
+++ b/CONTRIBUTING.md
@@ -0,0 +1,25 @@
+# Contributing to hello-toon
+
+Thank you for your interest in contributing!
+
+## Getting Started
+
+1. Clone the repository
+2. Run \`pnpm install\` to install dependencies
+3. Run \`pnpm test\` to verify everything works
+
+## Submitting Changes
+
+Submit patches via NIP-34 kind:1617 events. Keep diffs focused
+and minimal — every byte costs on TOON.
+
+## Code Style
+
+- Use TypeScript
+- Follow existing formatting conventions
+- Add tests for new functionality
+
+## Questions?
+
+Open a kind:1621 issue on the repo or comment on an existing one.
+`;

  const patchEvent = ctx.sign({
    kind: 1617,
    created_at: now,
    tags: [
      // a tag — repository address per kind-1617-patches.md § "Required Tags"
      ['a', `30617:${alicePubkey}:hello-toon`],
      // r tag — earliest unique commit per kind-1617-patches.md § "Required Tags"
      ['r', '1a2b3c4d5e6f'],
      // p tag — notify maintainer per kind-1617-patches.md § "Optional Tags"
      ['p', alicePubkey],
      // t tag — root of patch series per kind-1617-patches.md § "Optional Tags"
      ['t', 'root'],
      // commit and parent-commit per kind-1617-patches.md § "Optional Tags"
      ['commit', '1a2b3c4d5e6f'],
      ['parent-commit', '0000000000000000000000000000000000000000'],
    ],
    content: patchContent,
  });
  await ctx.publish(patchEvent);
  console.log(`[carol] Published patch (kind:1617) — CONTRIBUTING.md for hello-toon`);

  // -------------------------------------------------------------------------
  // (f) Kind:10001 — Pin list (NIP-51)
  // Skill: lists-and-labels § "kind:10001 -- Pin List"
  //   Tags: e (pinned event IDs)
  //   Content: NIP-44 encrypted JSON array of private pinned entries
  //            (empty string when no private entries)
  //   Replaceable event — one pin list per user
  //
  // Pin Carol's own highlight and her comment as showcased content.
  // -------------------------------------------------------------------------
  const pinListEvent = ctx.sign({
    kind: 10001,
    created_at: now,
    tags: [
      // e tags for pinned events per lists-and-labels skill § "kind:10001"
      ['e', highlightEvent.id],
      ['e', commentEvent.id],
      ['e', patchEvent.id],
    ],
    // Empty content = no private pinned entries per lists-and-labels skill
    content: '',
  });
  await ctx.publish(pinListEvent);
  console.log(`[carol] Published pin list (kind:10001) — pinned highlight, comment, and patch`);

  console.log(`[carol] All events published successfully.`);
});
