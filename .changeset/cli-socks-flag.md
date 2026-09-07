---
'@toon-protocol/client': minor
---

`toon --socks` and `TOON_SOCKS` point the CLI at a SOCKS5h proxy, so a payer who already runs an
Anyone Protocol `anon` daemon can reach a `.anyone` connector through it. The flag beats the
environment, as every other setting in this CLI does, and both paths use the operator's own daemon:
nothing is downloaded and no process is spawned. Clearnet runs are untouched.
