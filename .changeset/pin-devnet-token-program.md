---
'@toon-protocol/client': patch
---

A test now pins the token program behind the devnet mock USDC. The mint `34eSxY7q…` is owned by the classic SPL Token program (checked live on devnet), which is what `wallet.transfer` already builds for — a simulated CreateIdempotent against it succeeds. No behaviour change.
