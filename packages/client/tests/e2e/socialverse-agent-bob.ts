/**
 * Bob — "The Socialite"
 *
 * Bob loves engaging with the community. He sets up his profile, follows
 * the crew, posts social notes, reacts to Alice's content, comments on
 * an event, and publishes a long-form article about paid relays.
 *
 * Every event structure is cited to the TOON skill that defines it.
 */

import { runAgent, AGENT_IDENTITIES } from './socialverse-agent-harness.js';

await runAgent('bob', async (ctx) => {
  // -------------------------------------------------------------------------
  // (a) kind:0 — Profile metadata
  // Skill: social-identity/SKILL.md § "kind:0 -- Profile Metadata"
  //   Core fields (NIP-01): name, about, picture, nip05
  //   Extended fields (NIP-24): display_name, website, banner, bot
  //   "construct a kind:0 event with the desired fields"
  //   kind:0 is a replaceable event — only the latest matters
  // -------------------------------------------------------------------------
  const profile = ctx.sign({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({
      name: 'bob',
      display_name: 'Bob the Socialite',
      about: 'Community enthusiast on TOON Protocol. Every interaction is intentional when it costs real money. Let\'s make social media meaningful again.',
      picture: 'https://example.com/bob-avatar.png',
      website: 'https://bob.toon.social',
      bot: false,
    }),
  });
  await ctx.publish(profile);
  console.log(`[bob] Profile published (kind:0)`);

  // -------------------------------------------------------------------------
  // (b) kind:3 — Follow list (contacts)
  // Skill: social-identity/SKILL.md § "kind:3 -- Follow List (Contacts)"
  //   Tag format: ["p", "<pubkey-hex>", "<relay-url>", "<petname>"]
  //   (relay and petname optional)
  //   "construct a kind:3 event with the complete set of p tags"
  //   kind:3 is replaceable — latest is canonical
  // -------------------------------------------------------------------------
  const followList = ctx.sign({
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', ctx.peers['alice']!, ctx.relayUrl, 'alice'],
      ['p', ctx.peers['carol']!, ctx.relayUrl, 'carol'],
      ['p', ctx.peers['dave']!, ctx.relayUrl, 'dave'],
    ],
    content: '',
  });
  await ctx.publish(followList);
  console.log(`[bob] Follow list published (kind:3) — following alice, carol, dave`);

  // -------------------------------------------------------------------------
  // (c) kind:1 — Two short text notes
  // Skill: nostr-protocol-core/SKILL.md § "TOON Write Model"
  //   "Publishing on TOON means sending a payment alongside the event"
  //   kind:1 is a regular event (NIP-01 short text note)
  // -------------------------------------------------------------------------
  const note1 = ctx.sign({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: 'Just published my first note on a paid relay. Every byte costs real money here — no spam, no bots, just intentional communication. This is what social media should feel like.',
  });
  await ctx.publish(note1);
  console.log(`[bob] Note 1 published (kind:1)`);

  const note2 = ctx.sign({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000) + 1,
    tags: [],
    content: 'Hot take: paying $0.003 per post is the best content filter ever invented. My feed has zero engagement-bait, zero reply-guys, and zero algorithmic manipulation. The ILP-gated relay is the future.',
  });
  await ctx.publish(note2);
  console.log(`[bob] Note 2 published (kind:1)`);

  // -------------------------------------------------------------------------
  // (d) kind:7 — Reaction to one of Alice's events (NIP-25)
  // Skill: social-interactions/references/nip-spec.md § "kind:7 -- Reactions"
  //   Required tags: e (event being reacted to), p (author of reacted-to event)
  //   Optional tags: k (kind of reacted-to event)
  //   Content: "+" (like), "-" (dislike), emoji, or custom emoji shortcode
  //
  // Skill: social-interactions/SKILL.md § "kind:7 -- Reactions (NIP-25)"
  //   "A kind:7 event is a regular (non-replaceable) event expressing a
  //    reaction to another event."
  //
  // Using Alice's known pubkey from AGENT_IDENTITIES. Placeholder event ID
  // since Alice's events are not yet published when this script runs.
  // -------------------------------------------------------------------------
  const alicePubkey = AGENT_IDENTITIES.alice.pubkey;
  const placeholderAliceEventId = 'a'.repeat(64); // 64 hex chars placeholder

  const reaction = ctx.sign({
    kind: 7,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', placeholderAliceEventId, ctx.relayUrl],
      ['p', alicePubkey],
      ['k', '1'],
    ],
    content: '🔥',
  });
  await ctx.publish(reaction);
  console.log(`[bob] Reaction published (kind:7) — fire emoji on Alice's note`);

  // -------------------------------------------------------------------------
  // (e) kind:1111 — Comment on another event (NIP-22)
  // Skill: social-interactions/references/nip-spec.md § "kind:1111 -- Comments"
  //   Root scope tags (uppercase): E (event ID root)
  //   Required tags: K (root event kind as string), p (author being commented on)
  //   "Top-level comment on an event: Include the uppercase root tag (E)
  //    plus K for the root kind. No lowercase reply tags."
  //
  // Skill: social-interactions/references/scenarios.md § "Scenario 4"
  //   "Add root scope tags. For commenting on a regular event, add E tag:
  //    ['E', '<event-id>', '<relay-hint>', '<author-pubkey>']"
  //
  // Commenting on Bob's own first note (note1) as a top-level comment.
  // -------------------------------------------------------------------------
  const comment = ctx.sign({
    kind: 1111,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['E', note1.id, ctx.relayUrl, ctx.pubkey],
      ['K', '1'],
      ['p', ctx.pubkey],
    ],
    content: 'Replying to my own first post to test NIP-22 threading. Comments on TOON cost money too — about $0.003 for a short one like this. Worth every micro-cent for structured discussion.',
  });
  await ctx.publish(comment);
  console.log(`[bob] Comment published (kind:1111) on own note`);

  // -------------------------------------------------------------------------
  // (f) kind:30023 — Long-form article (NIP-23)
  // Skill: long-form-content/SKILL.md § "kind:30023 -- Long-form Articles"
  //   "parameterized replaceable event containing markdown in the content field"
  //   Required tags: d (article identifier, unique per author), title
  //   Optional tags: summary, image, published_at, t (hashtag topics),
  //                  subject (NIP-14 subject line)
  //   "Articles without a published_at tag are considered drafts"
  //   "Content format: markdown text"
  //
  // Skill: long-form-content/SKILL.md § "NIP-14 Subject Tags"
  //   "The subject tag adds a descriptive subject line to any event kind"
  // -------------------------------------------------------------------------
  const publishedAt = Math.floor(Date.now() / 1000).toString();

  const article = ctx.sign({
    kind: 30023,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'why-paid-relays-change-social-media'],
      ['title', 'Why Paid Relays Change Social Media'],
      ['summary', 'Exploring how ILP-gated relays transform online discourse by attaching real economic cost to every post, reaction, and repost.'],
      ['published_at', publishedAt],
      ['t', 'toon'],
      ['t', 'paid-relays'],
      ['t', 'social-media'],
      ['subject', 'The economics of intentional communication'],
    ],
    content: `# Why Paid Relays Change Social Media

## The Problem With Free

Free social media optimizes for engagement, not quality. When posting costs nothing, the rational strategy is to post as much as possible — hot takes, rage-bait, and engagement farming dominate because there is no cost to noise.

## Enter the Paid Relay

On TOON Protocol, every write operation is ILP-gated. Publishing a short note costs roughly $0.003. A reaction costs $0.002. Even a simple "like" requires a micro-payment. This changes everything.

## Quality Over Quantity

When every post has skin-in-the-game, writers compose more thoughtfully. You do not fire off a dozen half-formed takes when each one costs money. Instead, you write fewer, better posts. The economic friction is a feature, not a bug.

## Reactions Mean Something

On free platforms, a "like" is meaningless — it costs nothing and signals nothing. On TOON, reacting to someone's post means you valued it enough to pay for the reaction. A feed full of reactions becomes genuine social proof of quality.

## The Death of Spam

Bot-driven engagement becomes economically unsustainable. Spam accounts cannot mass-post when every message costs real money. The relay does not need complex moderation algorithms — the price mechanism handles it naturally.

## Conclusion

Paid relays do not just filter spam. They fundamentally reshape how people communicate online. By attaching real cost to every interaction, TOON Protocol creates a space where quality emerges organically from economic incentives. The future of social media is not free — it is intentional.`,
  });
  await ctx.publish(article);
  console.log(`[bob] Article published (kind:30023) — "Why Paid Relays Change Social Media"`);
});
