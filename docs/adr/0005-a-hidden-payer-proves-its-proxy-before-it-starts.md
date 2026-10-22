---
status: accepted
---

# A hidden payer proves its proxy before it starts

A hidden payer hands its proxy to four paths, each through a different hook: a dispatcher to
`fetch` for the client edge, an injected fetch to viem for EVM RPC and to the Solana client for
Solana RPC, and an `http.Agent` to `ws` for the BTP socket. If any one hook is silently ignored,
that path dials clearnet and still works, so the client looks healthy while it de-anonymises its
payer (#667). Whether a hook is honoured is a property of the installed Node and libraries, which do
not change for the life of a process. So `ToonClient.create` sends one **canary** down each path,
through the very objects real traffic will use, to a closed loopback port (port 2: `fetch` refuses port 1 outright). The proxy hook
recognises the canary, notes that it fired and refuses the dial. A canary the hook never saw is a
**proxy bypass**, and `create` throws `ProxyBypassError` (`PROXY_BYPASS`) naming the path and the
fix. Either way nothing leaves the machine, and a client without a `socksProxy` runs no canary.

## Considered options

- **A self-test over the network** at construction, dialling a known destination through the proxy
  and checking a name arrived. Rejected: a round trip per client, and a destination we would have
  to trust to report what it saw. The loopback canary proves the same thing without either.
- **A DNS tripwire** that throws if the OS is asked to resolve a `.anyone` name. Rejected: it is
  process-global, which a library must not be, and it is blind to the bypasses that succeed, chain
  RPC to public hosts and a clearnet connector, whose names resolve anyway.
- **A per-request check** that our dispatcher saw each request. Rejected: it notices a bypass only
  after the request has gone out on clearnet.

## Consequences

- EVM RPC goes through viem's `fetchFn` (viem `^2.37.2`) rather than a dispatcher in
  `fetchOptions`, so all three HTTP paths share one fetch the canary can test. This amends ADR 0002.
- A `fetch` or `createWebSocket` the caller injects is outside the guarantee: it already wins over
  the proxy for the client edge, and we do not own what it does with bytes.
- The canary proves a hook is honoured, not that every call site passes it. A call site that forgets
  the proxied fetch altogether is tracked separately.
