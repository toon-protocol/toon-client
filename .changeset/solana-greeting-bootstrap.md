---
'@toon-protocol/client': minor
---

`negotiateFromGreeting` now bootstraps a channel on Solana, not only EVM
(issue #470): a wallet holding only Solana devnet assets can open a channel
and sign Ed25519 claims against a settling connector it has never announced
to or registered with, exactly as an EVM wallet already could.

The x402 greeting's additive per-chain `settlements` list (connector #632)
is parsed alongside the legacy EVM-shaped `settlement` object — untagged on
the wire, disambiguated structurally (`tokenNetworkRegistry` names an EVM
entry, `programId` a Solana one). When a two-chain greeting carries both, the
EVM leg is still preferred by default; Solana is opened instead only when
the wallet holds Solana settlement funds and holds none on EVM. A
Solana-only greeting (no EVM leg at all) always opens Solana. An EVM-only
greeting — legacy shape or a one-entry `settlements` list — is unaffected.

The Solana channel-open and Ed25519 claim-signing machinery itself
(`ChannelManager`, `SolanaSigner`, `OnChainChannelClient`) already existed;
this wires the greeting-driven bootstrap path into it.
