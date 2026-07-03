---
"@toon-protocol/rig": minor
"@toon-protocol/views": minor
"@toon-protocol/rig-web": patch
---

fix(rig,rig-web)!: honor issue/PR status only from repo owner + declared maintainers (#287)

Issue/PR status (kind:1630-1633) was resolved naive last-write-wins over ALL
events regardless of signer, so any funded identity could overwrite another
owner's issue/PR state. State resolution now honors ONLY status events signed
by an AUTHORIZED author — the repo OWNER (always) ∪ the MAINTAINERS declared on
the kind:30617 announcement (a new `["maintainers", <hex>, …]` tag). Unauthorized
status events are ignored for state (a permissionless relay can still carry them,
so this is a consumer-side filter).

- `buildRepoAnnouncement` gains an optional maintainers list; `parseMaintainers` /
  `authorizedStatusAuthors` parse it. `RemoteState.maintainers` and the views
  `RepoMetadata.maintainers` surface it.
- `deriveStatus` (rig CLI tracker) and `resolvePRStatus` / `resolveIssueStatus`
  (views, used by rig-web) now take an authorized-author set and filter by it.
- New `rig maintainers list|add|remove <pubkey>` command republishes the 30617
  to manage the set (owner-only, confirm-gated).
- `rig pr status` / `issue status` warn when the active identity is not a
  maintainer (the write still publishes — permissionless — but the futility is
  made obvious).

BREAKING: `resolvePRStatus` / `resolveIssueStatus` require a third `authorized`
argument; `RepoMetadata` / `RemoteState` gain a required `maintainers` field.
