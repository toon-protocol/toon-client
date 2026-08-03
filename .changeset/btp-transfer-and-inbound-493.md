---
'@toon-protocol/client': minor
---

BTP client: accept server-originated MESSAGE and TRANSFER (issue #493, toon-meta#262 "agents earning"). The client dialect (`btp/protocol.ts`) was asymmetric — it only ever sent MESSAGE and resolved the reply through `pendingRequests`, so an agent behind NAT could spend but never be paid or handed a job. RFC-0023 says both sides "play identical roles" after auth; connector issue #697 landed the symmetric grammar server-side, and this closes the client half.

Adds `BTPMessageType.TRANSFER` (type 7, `amount` + `protocolData`, byte-compatible with `crates/connector-client-edge/src/btp.rs`'s own unit vectors — no ILP-packet field in either direction) to `serializeBtpMessage`/`parseBtpMessage`, and `ERROR`-frame serialization (previously decode-only). `IsomorphicBtpClient` gains `onMessage`/`onTransfer` config handlers: a server-originated request is dispatched to the handler and answered with a RESPONSE/ERROR under the same requestId — never through `pendingRequests`, which only ever correlates this client's own outbound sends (the two id spaces are distinguished by BTP frame type, not by whether an id value collides). An unset `onTransfer` still gets an empty RESPONSE ack, mirroring the connector's own default; an unset `onMessage` is dropped unanswered, matching the pre-#493 dialect exactly. `onInboundError` surfaces in-flight inbound work orphaned by a disconnect instead of it silently vanishing. `BtpRuntimeClientConfig` threads all three handlers through on both `connect()` and `reconnect()`, since a reconnect constructs a fresh `IsomorphicBtpClient`.

Additive throughout: a client that never sends TRANSFER and is never sent a server-originated MESSAGE behaves exactly as before.
