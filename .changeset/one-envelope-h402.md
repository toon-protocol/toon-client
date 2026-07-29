---
'@toon-protocol/client': major
---

Fold `Http402Client` onto the one envelope (#451).

`packages/client` carried two independent HTTP/1.1 codecs. #450 deleted the
first (`store-envelope.ts` / `fulfill-http.ts`); this removes the second, so
the package now has exactly one encoder and no HTTP text is serialised or
parsed anywhere in it.

`Http402Client`'s paid path (`payOverToon`) now fetches the terminating
connector's identity from the endpoint the 402 named, builds an OER
`EnvelopeRequest`, seals it under a condition derived from the sealed secret,
and opens the answer with `readExchangeOutcome` — the same `sealExchange` /
`readExchangeOutcome` pair `publishEvent` uses. Previously it sent a
zero-condition packet, which the Rust connector refuses outright.

**Breaking:** `serializeHttpRequest` and `parseHttpResponse` are removed from
`@toon-protocol/client`'s published surface. Neither is imported by
`packages/rig`, `packages/client-mcp`, or the standalone `toon-protocol/rig`.

Two deliberate behaviour changes on the paid path:

- **`Host` and `Content-Length` are no longer synthesised.** The connector
  strips both by name and lets its HTTP client recompute them
  (`connector-runtime/src/app_client.rs`), and the envelope already carries the
  body length as an OER length determinant. A caller that sets either
  explicitly still has it carried verbatim.
- **`Response.statusText` is empty.** An `EnvelopeResponse` status is two bytes
  with no reason phrase, so there is no `Created` to report; the status is the
  fact to read.

A malformed answer now fails as `SealedResponseError`, the same way it does
everywhere else in the package, resolving the two codecs' divergent failure
modes (`ConnectorError` on a bad status line here versus `{isHttp:false}`
there).

The unpaid path is unchanged: a non-402 passes through, and a 402 with no
`toon-channel` entry or no claim resolver is returned to the caller as-is.
