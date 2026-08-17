# Vendored Solana test fixture

`payment_channel.so` exists so
`../../solana-settlement-redeem.integration.test.ts` can stand up a **real**
`solana-test-validator` running the **real** payment-channel program at a
**fixed** address, with no network access and no Rust toolchain.

## `payment_channel.so` — the deployed program

|  |  |
| --- | --- |
| Source | [`toon-protocol/connector`](https://github.com/toon-protocol/connector) → `packages/solana-program/` (native Rust, **not** Anchor) |
| Source commit | `e9bfadad717e66ad9f6b99a929afed1514adce57` (tree `f193bd899e195c623d0c942cfaaba0d1652a8a21`) |
| Built with | `cargo build-sbf --tools-version v1.52` — the pin connector's own CI and `Makefile` use, and the one its `solana-program-reproducibility` job asserts is byte-stable |
| Size | 109,416 bytes |
| sha256 | `b15e3c808bda581457110193dcdecd060d22c0697b40ce245b4f9188c7497600` |

Byte-identical to the copies vendored by
`toon-protocol/swap` (`packages/swap/tests/e2e/fixtures/solana/`) and by the
toon monorepo's SDK redemption proof — asserted, not assumed: the test checks the
size AND the sha256 at boot, so a truncated or silently-swapped blob fails loudly
instead of producing a validator whose program rejects everything for reasons
that look like an encoding bug.

### Why vendor rather than build or clone

- **Build in CI**: adds a Rust toolchain plus Solana platform-tools (~200 MB) to
  a TypeScript repo, to produce 109 KB.
- **Clone from a live deployment** (`solana program dump` off public devnet):
  puts a third-party RPC in the critical path of a test, so a devnet outage
  becomes a red PR.
- **Vendor**: no toolchain, no network, byte-identical every run.

### Regenerating

```sh
cd /path/to/connector/packages/solana-program
cargo build-sbf --tools-version v1.52
cp ../../target/deploy/payment_channel.so \
   /path/to/toon-client/packages/client/src/__integration__/fixtures/solana/
sha256sum payment_channel.so   # update the table above AND the test's constants
```

The program has **no `declare_id!`** — it reads `program_id` from the entrypoint
and derives its PDAs from it — so its address is simply wherever the validator
loads it. The test loads it at
`HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR`, the same `LOCAL_TEST_PROGRAM_ID`
connector's own Rust harness uses
(`crates/connector-settlement-solana/src/test_support.rs`) and that swap's and
the SDK's harnesses use, so one local id means one set of PDAs across every
repo's tests.

The account layout this program writes — the 178-byte `ChannelState` with the
ASCII `pchannel` discriminator — is `packages/solana-program/src/state.rs` at
that same commit.
