---
"@toon-protocol/rig": patch
---

`rig balance`: flag channels whose cumulative claims exceed the recorded
on-chain deposit as OVERDRAWN. `available` is
`max(0, deposited − claimed)`, so an overdrawn channel showed `available 0`
with no indication that the signed claims had run past the collateral (e.g.
`deposited 100000 claimed 140840 available 0`). The on-chain TokenNetwork
caps redemption at the deposit, so the excess is unsecured — the balance
view now surfaces the overdraft amount and suggests a top-up. Adds an
`overdrawn` field to the `--json` envelope.
