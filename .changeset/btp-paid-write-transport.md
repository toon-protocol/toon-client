---
'@toon-protocol/client': minor
---

Add `BtpPaidWriteTransport` (issue #482): a persistent, strictly-ordered BTP
transport for paid writes, built on the connector's client-facing BTP
websocket ingress (client-edge-spec.md §1.9). It wraps a `BtpRuntimeClient`
session to give:

- a persistent socket, connected once and reused across many writes instead
  of the per-call open/close pattern `Http402Client.upgradeToBtp()` uses;
- strictly ordered claim dispatch — writes are enqueued FIFO and the next one
  is not sent until the previous has settled, which is what lets a burst of
  paid writes on one channel avoid racing itself into `F01
  NonceNotAdvancing` (measured on the huddle-over-ILP prototype: 0 F01
  rejects across 4,156 events at a sustained 50fps);
- reconnect-and-resume on a connection-level failure, without losing a
  write's place in the queue or reordering the writes behind it;
- automatic fallback to a configured HTTP transport once the reconnect
  budget for one write is exhausted.

`ToonClient` gets a new opt-in `preferBtpForPaidWrites` config flag (default
`false`) that routes `publishEvent`/`sendSwapPacket`/`sendPayment` through
this transport instead of the default stateless HTTP one-shot path, when a
`btpUrl` is configured. The default is unchanged: paid writes keep going
through HTTP unless a consumer explicitly opts in for a paid-write burst
(the motivating case is relay-native huddle audio, which needs sustained
strictly-ordered writes).
