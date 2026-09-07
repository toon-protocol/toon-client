---
status: accepted
---

# Chain RPC rides the same hidden-service proxy as the connector

When a `socksProxy` is configured, this client routes **chain RPC through it too** — not just the
connector's client edge. Reaching a connector over an anonymity overlay while calling a public RPC
provider over clearnet defeats the entire exercise: the RPC traffic carries the payer's settlement
address, its channel opens, deposits and nonce reads, from the payer's own IP, timed to sit either
side of every paid request. An observer correlates the two trivially. The only threat model in
which a hidden-service connector is worth its latency is exactly the one that leak destroys.

## Consequences

- This is the reason `undici` is an optional dependency. viem's HTTP transport calls the **global**
  `fetch` and accepts no injected one, so the only way to proxy it without monkey-patching
  `globalThis` is `http(url, { fetchOptions: { dispatcher } })` — and a dispatcher cannot be
  constructed without the `undici` module, which Node bundles internally but does not expose.
- A future reader who finds chain calls routed through SOCKS should not "fix" it.
- There is an opt-out for a payer running their own node on loopback, where the proxy hop buys
  nothing and costs latency.
