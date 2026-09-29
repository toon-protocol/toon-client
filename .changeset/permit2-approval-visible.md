---
'@toon-protocol/client': patch
---

A payer paying its own gas for a Permit2 deposit now waits until the RPC shows its `approve(Permit2)` before depositing, not only for the approval's receipt. On a load-balanced RPC such as `sepolia.base.org`, the deposit could be estimated on a backend that had not seen the approval yet, and reverted `TRANSFER_FROM_FAILED`.
