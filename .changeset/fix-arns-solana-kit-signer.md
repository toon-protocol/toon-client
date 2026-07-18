---
'@toon-protocol/rig': patch
---

Fix `rig name` against every published `@ar.io/sdk` (#376): the verbs guarded on a `SolanaSigner` export that no released SDK ships, so they always died with `arns_sdk_unavailable`. The default loader now drives the Solana-native SDK the way 4.0.3 actually works — an explicit `@solana/kit` `createSolanaRpc` transport (the SDK builds no defaults), plus `createKeyPairSignerFromBytes` over the identity's 64-byte Ed25519 key and an `rpcSubscriptions` client for writes only. `rig name status` (and all free reads) now runs signerless; "SDK not installed" (`arns_sdk_unavailable`) is distinguished from "SDK installed but API-incompatible" (`arns_sdk_incompatible`, minimum `@ar.io/sdk` 4.0.3 stated and pinned in optionalDependencies); and an env-gated live smoke test (`pnpm test:arns-live`) executes real free reads against the published SDK so the surface can never silently drift again.
