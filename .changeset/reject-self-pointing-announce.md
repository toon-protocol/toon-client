---
'@toon-protocol/client': patch
---

Refuse a discovered announce whose endpoint can only point at the client's own machine.

A `kind:10032` announce is served forever — the relay treats the kind as
parameterized-replaceable and implements neither NIP-40 expiry nor NIP-09
deletion, so replacing one needs its original signing key. A throwaway swap
maker on an operator workstation therefore left `g.toon.swap.sol` advertising
`ws://127.0.0.1:3401` on devnet permanently, as the only Solana→EVM pair a
client can see. Selecting it dials port 3401 on the CALLER's machine:
connection-refused at best, a BTP session opened against an unrelated local
service at worst.

New `announce-reachability` module (exported: `classifyEndpointZone`,
`rejectedAnnounceEndpoint`, `isAnnounceEndpointUsable`,
`announceEndpointPolicyFor`, `DEFAULT_ANNOUNCE_ENDPOINT_POLICY`), applied at
the three points where a discovered announce is selected: `ToonClient`'s
terminator resolution, `client-mcp`'s `discoverApex` (the `toon_add_apex` /
direct-dialled-maker path), and `rig`'s `pickPaymentPeer`.

- **Loopback** (`127/8`, `::1`, `localhost`, `0.0.0.0`, `::`) and
  **link-local** (`169.254/16`, `fe80::/10`) are refused by default: their
  meaning is relative to the reader, so a remote announcer's copy can never be
  correct for us.
- **Private ranges** (RFC1918, ULA, CGNAT/Tailscale) stay **allowed** — a LAN
  maker or a Docker-bridge rig is a real deployment. Opt out with
  `allowPrivate: false`.
- Local development is unaffected: a loopback endpoint discovered from a
  loopback relay is accepted automatically (local relay ⇒ local stack).
  `TOON_CLIENT_ALLOW_LOOPBACK_PEERS=1` is the explicit override for a local
  node that announces itself to a remote relay.

Refusals are loud at the point of selection — `TERMINATOR_UNRESOLVED` and
`ApexDiscoveryError` now name the endpoint, the host, why it is unreachable
and the escape hatch, instead of letting a confusing connection error surface
from the user's own machine.
