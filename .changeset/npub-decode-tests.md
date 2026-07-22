---
---

test(rig): add unit tests for `npubToHex`/`ownerToHex` decode+validate paths (#428)

Empty changeset on purpose: `packages/rig/src/npub.test.ts` is a new test-only
file with no production change to `npub.ts` — no runtime/API behavior changed,
so no version bump is warranted. This file exists solely to satisfy the CI
changeset gate.
