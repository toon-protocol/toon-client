---
'@toon-protocol/views': minor
---

Add a `profile-editor` atom that composes/updates a NIP-01 kind:0 profile from input fields (`name`, `display_name`, `picture` URL, `about`, optional `nip05`), serializes them into the kind:0 `content` JSON, and publishes via `toon_publish_unsigned` (`{ kind: 0, content }`) through the normal pay-to-write confirm flow. Bind a kind:0 event to pre-fill the form — unknown metadata fields (banner, lud16, …) are preserved on republish. Registered in the atom catalog/registry and surfaced as a `profile-editor` example view (editor + live `profile-header`).
