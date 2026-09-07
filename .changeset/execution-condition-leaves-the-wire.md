---
'@toon-protocol/client': major
---

The execution condition leaves the wire (connector ADR 0069, issue #1269).

`connector@main` no longer carries an `executionCondition` on a PREPARE: a
one-byte `greeting` flag sits where the 32-byte field was, and a packet still
carrying the condition is refused at the wire — misleadingly, as
`invalid packet type byte`. The vendored wire vectors move to schema 5 and this
client's codec follows them.

Breaking, and deliberately so — the ADR moves the vector schema version for
exactly this reason:

- `IlpSendParams.executionCondition` is replaced by `expectedFulfillment` (the
  32 bytes an honest FULFILL must carry, which is `SealedExchange.fulfillment`)
  and by `greeting` (the bootstrap-probe flag).
- `ILPPreparePacket.executionCondition` becomes `greeting: boolean`.
- `SealedExchange.condition` is gone; `sealExchange` still returns `data`,
  `sharedSecret` and `fulfillment`.
- `deriveCondition` and `resolveExecutionCondition` are no longer exported.
  `deriveFulfillment` is unchanged, and comparing a returned preimage against
  it is now the sender's whole delivery check — and the only fulfilment check
  made anywhere on the path, since no hop performs one.
