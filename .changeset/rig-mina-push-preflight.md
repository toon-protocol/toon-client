---
"@toon-protocol/client": patch
"@toon-protocol/rig": patch
---

Fix three related Mina-settlement bugs in `rig push` (standalone mode) that
made a first-time, unfunded, or interrupted Mina channel-open fail slowly and
wastefully:

- **Fee-payer preflight (fail fast).** Before compiling the `PaymentChannel`
  circuit (1–3 min) or attempting a zkApp deploy, the fee payer's on-chain
  MINA balance is checked. An account that does not exist / is under
  ~1 MINA (account-creation fee + tx fees) now throws
  `MinaFeePayerUnfundedError` naming the address, the required amount and the
  network — in seconds, before any compile. Previously the circuit compiled
  first and only then did `Mina.transaction` throw
  `getAccount: Could not find account for public key …`.

- **o1js transaction-nesting on retry.** `Mina.transaction` enters o1js's
  module-level `currentTransaction` context and then reads the fee-payer nonce
  (`getAccount(sender)`) OUTSIDE the try/finally that would leave it, so an
  unfunded fee payer leaked the context. The next `Mina.transaction` (the
  cache-invalidation retry) then threw `Cannot start new transaction within
  another transaction`. Every Mina tx now builds through `buildMinaTransaction`,
  which abandons any leaked context on failure so a retry starts clean; the
  preflight error is also treated as non-recoverable so it does not trigger a
  pointless topology re-resolution.

- **Orphaned zkApp deploys.** The dedicated per-pair zkApp key is now persisted
  BEFORE the deploy tx is sent (`onDeploying`), and a recorded-but-unconfirmed
  deployment is REDEPLOYED at the SAME address on the next run instead of
  minting a brand-new zkApp — so a crash or retry between deploy and
  confirmation no longer burns the ~1.1-MINA account-creation fee on a fresh
  zkApp each attempt.
