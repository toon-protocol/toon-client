---
'@toon-protocol/client': patch
---

`--help` no longer answers for a command that does not exist. `toon-client faucet drip --help` and `toon-client channel refill --help` now exit 2, as they do without `--help`; they used to print the command's help and exit 0.
