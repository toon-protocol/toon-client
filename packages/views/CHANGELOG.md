# @toon-protocol/views

## 0.1.2

### Patch Changes

- dcb9c89: Disable the pay-confirm "Confirm & pay" button when the fee status is unavailable (`statusError`), so a user can never click through a "fee unavailable" screen into a silent spend.
- 7d9b1db: Fix note-card bind producing empty render; reject unknown bind keys

  Two bugs caused an empty white container when using `note-card` with a NIP-01 filter bind:

  1. `validateViewSpec` silently accepted unknown `bind` keys (e.g. `filter` instead of the correct `query`), so the wrong key passed validation, was ignored at runtime, and resolved to zero events.
  2. `NoteCard` used `.find()` so only the first event rendered even when a query returned many events.

  `client-mcp` is bumped so the updated views bundle (with both fixes) is republished.

## 0.1.1

### Patch Changes

- a91f5c5: Fix note-card bind producing empty render; reject unknown bind keys

  Two bugs caused an empty white container when using `note-card` with a NIP-01 filter bind:

  1. `validateViewSpec` silently accepted unknown `bind` keys (e.g. `filter` instead of the correct `query`), so the wrong key passed validation, was ignored at runtime, and resolved to zero events.
  2. `NoteCard` used `.find()` so only the first event rendered even when a query returned many events.

  `client-mcp` is bumped so the updated views bundle (with both fixes) is republished.
