/**
 * Alice — Socialverse AI Agent
 *
 * Creates a profile, follow list, repository announcement, issues, and a note.
 * Every event structure is derived from the TOON skill files (cited in comments).
 */

import { runAgent } from './socialverse-agent-harness.js';

runAgent('alice', async (ctx) => {
  // -------------------------------------------------------------------------
  // (a) kind:0 — Profile Metadata
  //
  // Skill: social-identity/SKILL.md § "kind:0 -- Profile Metadata"
  //   - Core fields (NIP-01): name, about, picture
  //   - Extended fields (NIP-24): display_name, website, bot
  //   - Content is a JSON-serialized string
  //   - Replaceable event — latest kind:0 replaces previous
  //
  // Ref: social-identity/references/nip-spec.md § "kind:0 -- Profile Metadata"
  //   - Tags: optional ["i", ...] for NIP-39 external identity
  // -------------------------------------------------------------------------
  const profileEvent = ctx.sign({
    kind: 0,
    content: JSON.stringify({
      name: 'alice',
      display_name: 'Alice',
      about: 'TOON Protocol agent. Building decentralized git collaboration.',
      picture: 'https://example.com/alice-avatar.png',
      website: 'https://example.com/alice',
      bot: true,
    }),
    tags: [
      // NIP-39 external identity claim (social-identity/references/nip-spec.md § "NIP-39")
      ['i', 'github:alice-toon', 'https://gist.github.com/alice-toon/proof123'],
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
  //
  // Ref: social-identity/references/nip-spec.md § "kind:3 -- Follow List / Contacts (NIP-02)"
  //   - Position 1: pubkey hex (required)
  //   - Position 2: relay URL (optional)
  //   - Position 3: petname (optional)
  // -------------------------------------------------------------------------
  const followListEvent = ctx.sign({
    kind: 3,
    content: '',
    tags: [
      ['p', ctx.peers['bob']!, ctx.relayUrl, 'bob'],
      ['p', ctx.peers['carol']!, ctx.relayUrl, 'carol'],
      ['p', ctx.peers['dave']!, ctx.relayUrl, 'dave'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(followListEvent);

  // -------------------------------------------------------------------------
  // (c) kind:30617 — Repository Announcement
  //
  // Skill: git-collaboration/SKILL.md § "Repository announcement (kind:30617)"
  //   - Parameterized replaceable event; d tag is repo identifier
  //   - Declares clone URLs, relay preferences, maintainer list
  //
  // Ref: git-collaboration/references/kind-30617-repo-announcement.md
  //   - Required tag: d (repo identifier)
  //   - Optional tags: name, description, clone, web, relays, maintainers, t
  //
  // Ref: git-collaboration/references/toon-extensions.md § "Repository Management"
  //   - ~300-500 bytes, ~$0.003-$0.005 at 10n/byte
  // -------------------------------------------------------------------------
  const repoEvent = ctx.sign({
    kind: 30617,
    content: 'A demo repository for TOON Protocol git collaboration.',
    tags: [
      ['d', 'hello-toon'],
      ['name', 'Hello TOON'],
      ['description', 'A demo repository for TOON Protocol git collaboration.'],
      ['clone', 'https://github.com/alice-toon/hello-toon.git'],
      ['web', 'https://github.com/alice-toon/hello-toon'],
      ['relays', ctx.relayUrl],
      ['maintainers', ctx.pubkey],
      ['t', 'demo'],
      ['t', 'toon'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(repoEvent);

  // Repository address for issues (kind-30617 § "Validation Rules"):
  //   30617:<author-pubkey>:<d-tag-value>
  const repoAddress = `30617:${ctx.pubkey}:hello-toon`;

  // -------------------------------------------------------------------------
  // (d) kind:1621 — Issues (x2)
  //
  // Skill: git-collaboration/SKILL.md § "Issues (kind:1621)"
  //   - Anyone can report bugs, request features, or discuss topics
  //   - Content is markdown
  //
  // Ref: git-collaboration/references/kind-1621-issues.md
  //   - Required tags: a (repo address), p (repo owner pubkey)
  //   - Optional tags: subject (issue title), t (labels)
  //   - ~300-2000 bytes, ~$0.003-$0.02
  // -------------------------------------------------------------------------

  // Issue 1: Bug report
  const issue1Event = ctx.sign({
    kind: 1621,
    content:
      '## Bug Report\n\n' +
      '**Expected:** `greet("")` returns a default greeting.\n' +
      '**Actual:** Throws `TypeError: Cannot read property \'length\' of undefined`.\n\n' +
      '## Steps to Reproduce\n\n' +
      '1. Clone the repo and install deps\n' +
      '2. Call `greet("")`\n' +
      '3. Observe TypeError\n\n' +
      '## Environment\n\n' +
      '- Node.js 20\n' +
      '- hello-toon@0.1.0',
    tags: [
      ['a', repoAddress],
      ['p', ctx.pubkey],
      ['subject', 'greet() crashes on empty string input'],
      ['t', 'bug'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(issue1Event);

  // Issue 2: Feature request
  const issue2Event = ctx.sign({
    kind: 1621,
    content:
      '## Feature Request\n\n' +
      'Add support for localized greetings.\n\n' +
      'Currently `greet(name)` only returns English greetings. ' +
      'It would be useful to pass a locale parameter, e.g. `greet(name, "es")` for Spanish.',
    tags: [
      ['a', repoAddress],
      ['p', ctx.pubkey],
      ['subject', 'Add locale support to greet()'],
      ['t', 'enhancement'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(issue2Event);

  // -------------------------------------------------------------------------
  // (e) kind:1 — Short text note announcing the repo
  //
  // Skill: nostr-protocol-core/SKILL.md § "TOON Write Model (Summary)"
  //   - Publish via publishEvent() with ILP payment
  //   - kind:1 is a standard NIP-01 short text note
  //
  // No special tags required for kind:1 beyond standard Nostr event fields.
  // -------------------------------------------------------------------------
  const noteEvent = ctx.sign({
    kind: 1,
    content:
      `Announcing hello-toon — a demo repo for TOON Protocol git collaboration! ` +
      `Check it out: nostr:${repoEvent.id}`,
    tags: [
      // Reference the repo announcement event for discoverability
      ['e', repoEvent.id, ctx.relayUrl, 'mention'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  await ctx.publish(noteEvent);

  console.log(`[alice] All events published successfully.`);
});
