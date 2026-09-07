---
'@toon-protocol/client': minor
---

Pay a connector that is a hidden service. When `socksProxy` is set, `ToonClient.create` probes the
proxy port and builds the proxy-bound transport *before* the first `GET` of the self-description, so
that first request already rides the overlay and a daemon the payer forgot to start costs no signed
claim. The transport fills the `fetch` and `createWebSocket` injection points the client already had
— there is no transport branch and no new mode, and an explicitly injected `fetch` or
`createWebSocket` still wins. `close()` now releases the proxy's pooled sockets, so a process that
opened a hidden-service client still exits.
