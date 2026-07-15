---
---

test(rig-web): de-flake `seed-rig-data.test.ts`. The cache-miss assertion let `resolveGitSha` fall through to a real `fetch('https://arweave.net/graphql')`, whose failure was not guaranteed to land inside vitest's 5s timeout — an intermittent CI failure unrelated to the code under test. `fetch` is now stubbed per-test so a miss resolves deterministically and instantly (empty GraphQL result → null), and the test asserts the fetch was reached to prove the cache was genuinely cold.
