# Vendored Solana test fixture

`payment_channel.so` exists so
`../../daemon-solana-settle.integration.test.ts` can stand up a **real**
`solana-test-validator` running the **real** payment-channel program at a
**fixed** address, with no network access and no Rust toolchain.

This is a second, byte-identical copy of
`packages/client/src/__integration__/fixtures/solana/payment_channel.so` (see
that directory's README for provenance). Vendored again here rather than read
across the workspace boundary because `client-mcp`'s integration suite
resolves everything else — including `@toon-protocol/client` itself — as a
published dependency, not a relative path into a sibling package's `src/`; a
suite that reached across `../../../client/src/__integration__/...` would
break the moment either package's test layout moved. The assertion (size +
sha256, checked at the same boot-time gate this repo's other two copies use)
is what keeps the copies honest, not the path.

## `payment_channel.so` — the deployed program

|  |  |
| --- | --- |
| Source | [`toon-protocol/connector`](https://github.com/toon-protocol/connector) → `packages/solana-program/` (native Rust, **not** Anchor) |
| Source commit | `e9bfadad717e66ad9f6b99a929afed1514adce57` (tree `f193bd899e195c623d0c942cfaaba0d1652a8a21`) |
| Built with | `cargo build-sbf --tools-version v1.52` |
| Size | 109,416 bytes |
| sha256 | `b15e3c808bda581457110193dcdecd060d22c0697b40ce245b4f9188c7497600` |

See `packages/client/src/__integration__/fixtures/solana/README.md` for the
full provenance and regeneration steps — regenerate both copies together and
update every constant that names the size/hash (this test's `PROGRAM_SO_*`
plus the sibling copy's).
