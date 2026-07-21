---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
"@toon-protocol/rig": patch
---

Drop the temporary local Base Sepolia (`evm:base:84532`) preset overrides now
that `@toon-protocol/core@3.1.1` ships the corrected public-devnet addresses.

- Bump `@toon-protocol/core` to `^3.1.1` in `client`, `client-mcp` (both from
  `^3.0.0`) and `rig` (from `^2.0.1`, a major jump), so the correct Base Sepolia
  USDC (`0x49beE1…`, 6-decimal) + TokenNetwork (`0x1E95493f…`) and the corrected
  Solana devnet payment-channel program (`2aEVJ8ko…`) flow straight from the
  package.
- Remove the `evm:base:84532` correction block (and the `BASE_SEPOLIA_*`
  constants) from the client's `applyNetworkPresets` — the values now come
  directly from core's `base-sepolia` preset.
- Remove the `BASE_SEPOLIA_PRESET` override (and its early `id === 84532`
  return) from the rig standalone `evmPresetForChain`, letting it fall through
  to core's `CHAIN_PRESETS['base-sepolia']`.

The relay-default hardening and the `rig fund` USDC-only routes from the prior
change are unaffected. Completes the follow-up from PR #404 / toon#104.
