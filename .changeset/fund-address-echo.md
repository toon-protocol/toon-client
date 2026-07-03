---
'@toon-protocol/rig': patch
---

`rig fund`: echo the funded (or attempted) wallet address on each per-chain line
of the human (non-`--json`) output — `evm ✓ funded (ETH + USDC) → 0x…` /
`solana ✗ → <address> — <error>`. The multi-chain rewrite (#309) had dropped the
address from the terminal output, leaving no confirmation of WHERE funds went;
this restores it, which matters most when `--address` targets an arbitrary,
non-derived address a typo could misdirect.
