---
'@toon-protocol/rig': minor
---

feat(rig): `rig init` sets the git commit-author from the nostr identity

`rig commit` is a git passthrough, so on a repo where the user never set a
global git identity it dead-ended on git's "Author identity unknown / empty
ident name not allowed". `rig init` now sets this repo's LOCAL git author
(never `--global`) from the resolved nostr identity, so `rig commit` /
`git commit` work out of the box and every commit is attributed to the signer
— commit author == push signer == nostr identity, a coherent authorship chain
baked into the git objects on Arweave.

- `user.email` = `<npub>@nostr` (npub is a valid email local part).
- `user.name` = the identity's kind:0 profile display name when published
  (prefer `display_name`, else `name`, read latest-wins from a resolvable
  relay), best-effort; falls back to the npub when there is no profile, no
  resolvable relay, or the read fails. Relay resolves at init time from
  `--relay` → `origin`/`toon.relay` → the genesis seed, with a short
  (~3s, `RIG_PROFILE_TIMEOUT_MS`-overridable) timeout — init never blocks or
  errors on the profile read.
- Idempotent: a later `rig init` refreshes `user.name` from a now-readable
  profile. Reported in the human output and in `--json` as
  `gitAuthor: { name, email, source: 'profile' | 'npub' }`.

Closes #302.
