---
"@toon-protocol/views": minor
"@toon-protocol/client-mcp": patch
---

Redesign `note-card` as an X-style post with clear Like and Follow affordances.

- **Header row** now reads like an X post: avatar → display name (bold) ·
  `@handle`/npub (muted, via MonoId) · "·" · relative timestamp, with a compact
  **Follow** button (outline pill) on the right for the author.
- **Action bar** is an X-style left-aligned icon row: **Reply**
  (speech-bubble) → `reply`; **Like** (lucide `Heart`, with the live reaction
  count) → the existing `react` action publishing kind:7 `"+"` — the "React"
  label is now surfaced as **Like**, and the heart fills + tints accent on an
  optimistic toggle. Repost stays an icon-less no-op tracked in #103 (kind:6
  publishing is out of scope here).
- **Follow** is a new action on `note-card`: it publishes a NIP-02 kind:3
  follow list adding the author's pubkey, by passing `tags: [['p', author]]`
  as a runtime arg that the runtime merges over the spec's static publish args
  (mirrors `follow-button`). The button toggles to "Following" optimistically.
- **Feed-level interactivity:** in a `kindAuto` feed (the "show me kind:1
  events" view), events render via the runtime's auto-render path, which
  previously wired no actions — so the card was read-only. The runtime now
  supplies **default engagement actions derived from the event itself**
  (`buildDefaultEventActions`): Like → NIP-25 kind:7 `"+"` tagging
  `['e', id] ['p', author]`; Follow → NIP-02 kind:3 adding `['p', author]`;
  Reply → kind:1 tagged `['e', id, '', 'reply'] ['p', author]`. So Like/Follow
  work one-tap in the actual feed, not just in hand-composed ViewSpecs. The
  explicit-ViewSpec path is unchanged (it still wins; defaults only fill the
  auto-render gap). Both paths share one `wireAction` write seam.
- **Inline reply composer:** the Reply button expands a small textarea + Send
  (⌘/Ctrl+Enter) right in the card that publishes the typed body as a kind:1
  reply (tags from the runtime base args), instead of posting an empty note.
- Like, reply, and follow are paid writes; a subtle footnote notes that each
  action spends the per-event channel fee. No heavy pay-confirm is forced for a
  like (optimistic toggles keep it snappy).
- `note-card` now declares the `toon_publish_unsigned` write in both the React
  registry and the catalog (so `toon_atoms` advertises it and the ViewSpec
  validator allows reply/react/follow); description/propsSchema updated. Atom id
  and registered kind (1) are unchanged; built on the existing shadcn/OKLCH
  tokens + lucide-react with no new deps.

`client-mcp` reships the refreshed app bundle that includes the redesigned card.
