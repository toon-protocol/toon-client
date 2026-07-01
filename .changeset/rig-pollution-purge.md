---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': patch
---

Purge pet-game era code and disambiguate "control plane" naming.

**Breaking (`@toon-protocol/client`):** the pet DVM/marketplace module (`src/pet/`) is removed along with its public exports — `filterPetDvmProviders`, `buildPetInteractionRequest`, `parsePetInteractionResult`, `parsePetInteractionEvent`, `buildPetListingEvent`, `parsePetListing`, `filterPetListings`, `buildPetPurchaseRequest`, and the associated types (`PetDvmProvider`, `PetInteractionRequestParams`, `PetInteractionResultData`, `PetInteractionEventData`, `InteractionResultContent`, `UnsignedNostrEvent`, `StatValues`, `ProofStatus`, `PetListingParams`, `PetListing`, `PetListingFilterOptions`, `PetPurchaseRequestParams`). These were orphaned helpers for the archived pet-game product; nothing in this repo consumes them.

`@toon-protocol/client-mcp`: docs/comments only — the loopback daemon HTTP surface is now consistently called the "control API" (matching the components table) instead of "control plane", which is reserved for the Rig (the browser-only decentralized control plane). No code identifiers or behavior changed.
