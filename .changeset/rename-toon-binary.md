---
'@toon-protocol/client': major
---

BREAKING: the payer CLI's binary is now `toon-client`, no longer `toon`, so it installs beside the operator CLI whose command is `toon`. Type `toon-client` wherever you typed `toon`: `npx toon-client send …`, `toon-client channel open`, `toon-client init`. Help text, error messages and the docs use the new name. State directories (`~/.toon/`) and environment variables (`TOON_*`) are unchanged, so existing keystores and channels keep working.
