---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': minor
---

Rolling-swap prerequisite (#350): transports send a real sender-chosen ILP
executionCondition and verify the FULFILL preimage.

- Both ILP transports (`HttpIlpClient` `POST /ilp` and `BtpRuntimeClient` BTP)
  accept an optional 32-byte `executionCondition` and explicit `expiresAt` and
  set them on the wire; the default stays the legacy all-zero condition, so
  existing publish/upload writes are byte-for-byte unchanged.
- On FULFILL with a non-zero sent condition, the client verifies
  `sha256(fulfillment) == condition` and surfaces a mismatch (or a missing /
  malformed / all-zero preimage) as a FAILED, non-retried packet (code F99) —
  never a silent accept. The FULFILL's 32-byte preimage is now captured from
  the OER wire instead of skipped.
- `ToonClient.sendSwapPacket` plumbs `executionCondition`/`expiresAt` through
  to whichever transport is active; new exports `mintExecutionCondition`,
  `fulfillmentMatchesCondition`, `isZeroCondition`, `assertValidCondition`,
  and the `IlpSendParams`/`IlpSendResultWithFulfillment` types.
- Daemon `POST /swap` gains opt-in `senderConditions`: the swap path mints one
  FRESH condition per packet (`C_i = sha256(P_i)`, rolling-swap spec §3 R1/R2).
  Requires a maker + connector implementing the sender-chosen fulfillment
  contract (connector#309); default off.
