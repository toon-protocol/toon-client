---
'@toon-protocol/rig': patch
---

`rig balance` never exits silently on the Mina settlement path. The wallet read
(`money.walletChainBalances()`) was awaited unbounded, so a Mina read that
neither resolved nor kept a live handle open let Node's event loop drain and the
one-shot CLI exit `0` with no output at all — only the earlier settlement-chain
alignment warnings on stderr. The read is now time-bounded
(`RIG_BALANCE_WALLET_TIMEOUT_MS`, default 20s; `0` opts out): its live timer
prevents the drain and forces a decision. On a hang or a rejected read, balance
prints the identity + recorded channels plus a loud, actionable wallet notice
and exits non-zero (a single error envelope under `--json`) — the report and
channels are still shown, never a silent success.
