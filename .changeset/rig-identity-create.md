---
'@toon-protocol/rig': minor
---

`rig identity create` — generate an identity on first run (#294).

rig could never MINT a signing identity: a brand-new user hit
`MissingIdentityError` and had to hand-mint a BIP-39 phrase out of band before
anything ran (`git init` works instantly by comparison). New `rig identity`
command group closes the cold-start wall while keeping rig's never-persist /
never-print-a-phrase invariants intact:

- `rig identity create` — generate a fresh BIP-39 mnemonic (via the client's
  existing generator — no hand-rolled bip39/crypto), display it ONCE with a
  prominent backup warning, then persist it to the encrypted keystore under
  `TOON_CLIENT_HOME` (reusing the client/daemon keystore-write path + the
  auto-password convention; `TOON_CLIENT_KEYSTORE_PASSWORD` overrides the
  encryption password — never a CLI flag, which would leak a keystore secret
  to shell history / `ps`). Refuses to overwrite an existing identity/keystore
  without `--force`.
- `rig identity show` — the active identity's source + derived pubkey (never
  the phrase).
- `rig identity import` — write an existing phrase, read from stdin (never a
  CLI argument), to the keystore.

`rig init` no longer dead-ends on a chain miss: in a TTY it offers to generate
(`Create a new identity now? [y/N]`), and `rig init --generate-identity` does
it non-interactively; the `MissingIdentityError` remediation now leads with
`rig identity create`. Nothing is ever generated without an explicit yes/flag.

The phrase is written ONLY to the encrypted keystore (never to git config, a
repo file, or plaintext). `rig identity create --json` is the ONE sanctioned
path that emits the phrase in machine output (a `mnemonic` field, for the
scripting/agent path); `identity show`/`import` never do, and the strict
single-JSON-document stdout contract holds for every new verb.
