---
"@toon-protocol/client": patch
---

Derive the Solana deposit payer ATA instead of requiring it in config. A Solana
channel deposit previously threw "Solana deposit requires
solanaConfig.deposit.payerTokenAccount" because callers (rig) never supplied the
payer's SPL token account — but it is deterministic (the owner's ATA for the
channel mint), and the client already has both the payer keypair and the mint.
Adds `deriveAssociatedTokenAccount` and derives the ATA in the deposit and
open-with-deposit paths when the caller did not pass one.
