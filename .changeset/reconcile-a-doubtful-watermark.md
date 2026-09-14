---
'@toon-protocol/client': minor
---

A claim whose fate is unknown no longer desyncs the watermark (#671).

A paid request that **times out** may have been delivered anyway — the connector
banks the claim while this end sees nothing. The client repays the amount
locally, which is the safer guess, but the guess used to stand forever: from
then on every claim under-advanced by the same gap and was refused, `F03`
("advances value by 0, less than this route's price") and then `F01`
("cumulative goes backwards"). Nearly unreachable on a clearnet loopback;
ordinary over a hidden-service circuit, where a 120s per-packet timeout and real
RTT make timeout-but-delivered a routine event.

The repayment stays. What changes is that it is no longer believed unquestioned:

- A transport error, a timeout, or a refused claim marks that channel's
  watermark **doubtful**, and the next request on it re-reads
  `POST /ilp/claim-state` for that one channel and adopts the connector's own
  figure **before** signing — the same read that previously happened only after
  two refused attempts.
- The doubt is persisted beside the watermark (`channels.json` gains an optional
  `watermarkUncertain` and `signedCeiling`), so a timeout in one `toon`
  invocation is settled by the next one.
- It is cleared for free by the first claim the connector banks, so a healthy
  channel never pays for the read.
- An adopted cumulative is clamped to the highest figure this client has ever
  signed — a connector can only bank a claim it holds a signature for — and a
  nonce is never lowered.

New on `ChannelManager`: `markWatermarkUncertain`, `markWatermarkCertain`,
`isWatermarkUncertain` and `adoptConnectorWatermark`. `SendContext` gains an
optional `reconcileWatermark` port.
