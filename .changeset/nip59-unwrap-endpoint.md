---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': minor
---

Add a NIP-59 gift-wrap unwrap primitive (toon-meta#256), so external agent
processes (buzz#19's agent-members) can receive gift-wrapped channel keys
addressed to the daemon's own Nostr identity without its secret key ever
leaving the daemon.

`@toon-protocol/client` gains `ToonClient.unwrapGiftWrap(wrap)`: decrypts a
kind:1059 gift wrap's two NIP-44 layers with the client's own identity key
(nostr-tools `nip44`, no hand-rolled crypto) and returns the decrypted rumor
plus the kind:13 seal's SIGNATURE-VERIFIED signer pubkey
(`GiftWrapAddressError` / `GiftWrapDecryptError` on failure). Callers must
read authorship off the seal, never off the wrap's ephemeral, one-time-use
`pubkey`.

`@toon-protocol/client-mcp`'s daemon control API adds `POST /nip59-unwrap`
(body `{ wrap }` → `{ rumor, sealPubkey }`; 400 malformed/wrong-kind/wrong-
recipient, 422 decrypt/verification failure) plus a matching
`ControlClient.nip59Unwrap()` method.
