---
---

Test-only: the "leaves an unpinned route on a pinning node on HTTP" unit test in `ToonClient.test.ts` now sets the fake connector's `routePrice` to `0n`, so the "free" route it exercises is actually free at the fixture's own pricing endpoint rather than just in the self-description's route list. Previously the mismatch made `send` treat the route as priced (at the fixture's default 1000), which opened a real payment channel and dialed a live chain RPC (`sepolia.base.org`), timing out in CI. No runtime code changed.
