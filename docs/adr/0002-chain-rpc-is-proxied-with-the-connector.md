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

## Amended by TOON_Network#167: the payer can be the one hiding

This record was written for a `.anyone` connector, and the client refused a `socksProxy` beside a
clearnet one as "nothing would ride the proxy". That refusal is reversed. The argument above holds
just as well when the connector is public and the payer is hiding its own address, as a Hidden
Provider's directory publisher does: one RPC call from the payer's own IP, next to its settlement
address, links the two. So a `socksProxy` beside a clearnet connector is accepted, and it carries
the client edge, the BTP socket and every chain's RPC, exactly as it does for a hidden service.
Before this, such a payer wired the proxy's `fetch` by hand and its chain RPC dialled direct, which
is why a Hidden Provider had to run its own chain node.

Chain RPC now follows connector ADR 0073, which made the same call for the connector:

- **One pinned circuit per chain.** Each chain's RPC authenticates to the SOCKS port with a fixed
  username (`toon-client-rpc-evm`, `toon-client-rpc-solana`). `anon`'s `IsolateSOCKSAuth` keeps
  each chain on its own circuit, away from the client edge's. A circuit per call would cost about
  seven times the latency and hide nothing from an RPC that links calls by the keys they name.
- **Bounded waits sized for a circuit.** A 20 s SOCKS connect, 30 s per request, retries with
  backoff on 403, 429, 5xx and dropped connections, and an idle pool capped at 30 s.
- **An outcome is reported by transaction.** Solana confirmation survives a failed poll and ends
  only as confirmed, failed, expired (past `lastValidBlockHeight`) or unknown. An EVM receipt wait
  survives a failed poll up to a 180 s deadline. A Solana send whose answer was lost is looked up
  by its own signature, not reported as a failure.
- **Still fail closed.** A proxy that is down fails the call. Nothing dials the RPC directly unless
  `proxyRpc: false` says to.
