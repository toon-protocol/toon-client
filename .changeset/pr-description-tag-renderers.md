---
'@toon-protocol/views': patch
'@toon-protocol/client-mcp': patch
---

kind:1617 PR descriptions (#280): `parsePR` surfaces the new `description`
tag (`rig pr create --body`) as `PRMetadata.description`, the forge PR card
shows it, and the daemon's `POST /git/patch` accepts an optional
`description` field it forwards into the built patch event's tag — content
stays pure `git format-patch` output for `git am`.
