# Vendored Solana test fixture

`payment_channel.so` exists so
[`../../solana-channel-lifecycle.integration.test.ts`](../../solana-channel-lifecycle.integration.test.ts)
can stand up a **real** `solana-test-validator` running the **real**
payment-channel program at a **fixed** address, with no network access and no
Rust toolchain.

## `payment_channel.so` — the deployed program

|               |                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Source        | [`toon-protocol/connector`](https://github.com/toon-protocol/connector) → `packages/solana-program/` (native Rust, **not** Anchor)   |
| Source commit | `792d12a0c85a228cf51f226945307156c6f126fb` — the last commit touching `packages/solana-program/`, connector#1119                     |
| Vendored from | a local connector checkout at `6ea60091da988d93f0a8c71e20fecd691d0a6983`, `target/deploy/payment_channel.so` (built locally)         |
| Built with    | `cargo build-sbf --tools-version v1.52` — the pin connector's own CI and `Makefile` use, and the one its `solana-program-reproducibility` job asserts is byte-stable |
| Size          | 109,400 bytes                                                                                                                        |
| sha256        | `ae2e91488c5b7920ca58279359d99cf8a3726d6b3f3b80a398a014af759e7e87`                                                                    |

**This is a post-ADR-0053 build.** Its `claim_from_channel` verifies the 96-byte
`TOON-BALPROOF-V2` balance proof and refuses the 48-byte predecessor **on
length**, before it compares any bytes. The previous fixture here (109,416
bytes, sha256 `b15e3c80…`, connector `e9bfadad…`) predates that change and
accepts the old message, so a suite run against it would prove the opposite of
what it claims to prove. That is the whole reason this file was replaced rather
than left alone: the negative case — "a legacy signature is refused" — is only
evidence if the program under test is the one that refuses it.

The test checks the size AND the sha256 at boot, so a truncated or silently
swapped blob fails loudly instead of producing a validator whose program rejects
everything for reasons that look like an encoding bug.

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
the connector's own Rust harness uses
(`crates/connector-settlement-solana/src/test_support.rs`), so one local id means
one set of PDAs across both repos' tests.

Because the program id is part of the signed balance proof (ADR 0053), that
shared local id is also what makes a proof signed in this suite redeemable by
this suite's validator and by nothing else.

The account layout this program writes — the 178-byte `ChannelState` with the
ASCII `pchannel` discriminator — is `packages/solana-program/src/state.rs` at
that same commit, and is decoded field-for-field by
`src/channel/solana/payment-channel.ts`'s `decodeChannelAccount`.
