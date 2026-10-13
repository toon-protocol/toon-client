---
'@toon-protocol/client': patch
---

`toon-client describe` and `price` no longer open the keystore. They sign nothing, so they run with a throwaway identity whether or not `~/.toon/keystore.json` exists; before this a machine that had run `init` was prompted for a password, and a script with no terminal stopped with "a keystore password is needed and stdin is not a terminal". `TOON_MNEMONIC`, when set, is still used.

The docs now name the executable the package ships, `toon-client`: every `npx toon …` was wrong since the rename in 5.0.0, and `npx toon` resolves to an unrelated package. The getting-started walk-through shows what the devnet store really answers to its example (a paid `422`, since the store wants a signed Nostr event) instead of a stub's `200`, says when `send` needs a destination, and warns that leaving a channel needs native gas before you depend on a deposit coming back.
