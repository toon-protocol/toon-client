---
'@toon-protocol/client': patch
---

Fix `client.channel.ensure()` leaving a RESUMED channel unadopted, so the first `deposit()` / `close()` / `settle()` after it failed with `No on-chain context for channel … this client cannot deposit into a channel it neither opened nor adopted`. A channel resolved from the store is resumed rather than opened, and on that path the chain client does not exist yet (it is built lazily by `onChainClient()`), so the manager's own adoption during resume had nothing to hand the context to. `requireChannel` adopts for exactly this reason — but returns `current` untouched when it is already set, and `ensure()` is what sets it. `ensure()` now adopts the resumed channel itself, the way `requireChannel` does when it resolves one. Found by `rig channel open --deposit` on the shared devnet: the channel it had just paid on could not be topped up.
