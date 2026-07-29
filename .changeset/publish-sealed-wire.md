---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': minor
'@toon-protocol/rig': minor
---

`publishEvent` now speaks the sealed wire (toon-client#450). **Breaking.**

A paid write is no longer a latin1 HTTP/1.1 request in `Prepare.data`. It is a
gift wrap addressed to the connector that TERMINATES the destination, around an
OER `EnvelopeRequest` (ADR 0018) — so `publishEvent` fetches that connector's
identity from its own client edge (`GET /ilp/identity`) before a packet can be
formed at all, and refuses to form one without it rather than falling back to
any default.

**The condition is now real.** Every publish previously sent an ALL-ZERO
execution condition — `publishEvent` passed none and both transports
zero-filled — which the Rust connector refuses outright (`condition_is_present`
in `connector-domain`). It now mints `sha256(deriveFulfillment(sharedSecret))`
from the secret it sealed (ADR 0019): derived, never random, never caller
supplied, and verified against the returned preimage by the transport. This is
what makes the publish path work against that connector at all.

**The answer is opened, not re-parsed.** A FULFILL's `data` is a sealed
response envelope, opened with the same secret and returned whole as
`PublishEventResult.response` — status, headers and body. A non-2xx status
rides home on a FULFILL and value moved (ADR 0020), so `response` is populated
either way. A reject sealed at the termination is reported as the DESTINATION
refusing (`refusedBy: 'destination'`, provable — only the termination holds the
secret); a plaintext one as a PATH refusal (`refusedBy: 'path'`).

### Removed from the published surface

- `buildStoreWriteEnvelope`, `parseFulfillHttp`, `parseFulfillHttpBytes` and
  `ParsedFulfillHttp` — `utils/store-envelope.ts` and `utils/fulfill-http.ts`
  are deleted. There is no HTTP text on this wire to parse.
- `ILP_CLAIM_WRAPPED_HEADER` — a declared NIP-59 hook never set or read
  anywhere.
- `PublishEventResult.data` (raw base64 FULFILL bytes) → `response`, the opened
  envelope. `extractArweaveTxId` takes that envelope rather than a base64
  string.

### Added

- `sealExchange` / `readExchangeOutcome` (`src/wire/sealed-exchange.ts`): the
  seal, the condition and the reader for the answer, produced together so they
  cannot drift apart, plus `envelopeHeader` and `SealedResponseError`.

### Downstream

`packages/rig` and `packages/client-mcp` in this repo move with it. The
standalone `toon-protocol/rig` repo pins the published `^0.21.1` and needs its
own release: `standalone-publisher.ts` imports `parseFulfillHttp` and keeps a
duplicated `extractArweaveTxId` — both go, since the client's extractor is
exported (the comment claiming otherwise is stale).

The ILP layer is unchanged: same `POST /ilp`, same OER PREPARE/FULFILL/REJECT,
same `ILP-Payment-Channel-Claim` header, same channel and watermark machinery.
Only `data` and the condition changed.
