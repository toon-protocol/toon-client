---
'@toon-protocol/client': patch
---

`toon-client channel <subcommand> --help` now exits 2 when there is no such subcommand, as it does without `--help`. It used to print the channel help and exit 0, which said a subcommand existed that did not.
