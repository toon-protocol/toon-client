---
'@toon-protocol/client': major
---

**Every payment is now an x402 `batch-settlement` voucher.** The `toon-channel` stack is gone. This mirrors the connector, which accepts nothing else (connector ADR 0075, #692).

A connector publishes its x402 channel terms on `GET /ilp` under `batchSettlements`. It publishes the same terms in its 402 greeting's `accepts[]`, with TOON's own facts in `extensions.toon.info` (wire vectors `schema_version` 7). The client pays it from an x402 `batch-settlement` channel on Base or Solana:

- **Onboarding costs no native gas.**
  - On Base, the first paid `send()` deposits through an x402 facilitator. The facilitator relays the deposit and pays its gas. The devnet default is `https://onboard.devnet.toonprotocol.dev`; set `facilitatorUrl` for any other network.
  - On Solana, the connector sponsors the open. The client builds and signs the payment-channels `open` and posts it to the node's `sponsorEndpoint`. The client first checks the mint's token program and the payer's token account.
- **Every paid packet carries a voucher.**
  - On Base it is an EIP-712 `Voucher(channelId, maxClaimableAmount)`. On Solana it is the 50-byte Ed25519 message.
  - Each voucher is exactly the running total plus the route's charge. There is no nonce.
  - A free route carries no voucher.
- **When the deposit runs short,** a Base channel is topped up through the facilitator. An exhausted Solana channel is replaced by a fresh sponsored one, because the sponsor endpoint only opens channels.
- **Exit is the payer's own transaction** and the one step that costs gas:
  - On Base, `close()` initiates a withdrawal and `settle()` finalizes it.
  - On Solana, `close()` sends `request_close`, and `settle()` seals and sends `withdraw_payer`.
- **Watermark safety:**
  - The amount is persisted before a voucher is signed, and a deposit is recorded before it is sent.
  - A voucher lost to a transport error stays counted.
  - A refusal that names the connector's watermark is adopted.
  - A refusal that does not name it, or a lost local store, is resolved by asking `POST /ilp/claim-state` with a signed voucher challenge.
- **BTP auth** proves the channel with a signed `channelChallenge`.

### Breaking changes

**Config**
- `batchSettlement: {…}` is gone. `facilitatorUrl`, `depositMethod` (`'eip3009'` or `'permit2'`) and `deposit` are top-level.
- `settlementTimeout` is gone.

**`client.channel`**
- It is now `{ channels(), current(), open(), deposit(amount), close(), settle() }` over x402 channels.
- `close()` and `settle()` return one `BatchExitResult` per channel.
- `state()`, `id` and `open({ deposit })` are gone.
- `client.batchSettlement` is gone. Use `client.channel`.

**Claims and claim-state**
- `ClaimSummary` is `{ channelId, chain, cumulative, amount }`: no `nonce` and no `scheme`.
- `client.claimState()` returns the voucher shape: `cumulativeClaimed`, `maxCumulative`, `available`, `lastClaimTime`. Its errors are `expired`, `unverified` and `toon-channel-refused`.

**Parsed terms and errors**
- `NodeSelfDescription.settlements` is replaced by `batchSettlements` and `voucherSigners`.
- `PaymentTerms.settlements` is replaced by `batchSettlements`.
- The greeting parses to `ParsedX402Challenge { toon, batchSettlements }`.
- `ChainUnavailableError.offered` lists CAIP-2 networks.

**CLI**
- `toon channel open|deposit|status|close|settle` act on x402 channels. `status --connector-view` shows the connector's figures beside the local ones.
- The `--batch-settlement` and `--settlement-timeout` flags are gone. `--facilitator` (`TOON_FACILITATOR`) and `--deposit` remain.

**Removed exports**
- `ChannelManager`, `OnChainChannelClient`, `TokenNetworkClient` and their ABIs and channel-id helpers.
- `SolanaSigner`, `EVMClaimMessage`, `ChainSigner`, `settlementToTerms`, `parseSettlementEntry`, `counterpartyMatch` and the stale-channel helpers.

### Added

- **Channel machinery:**
  - `BatchSettlementPayer`, `BatchChannelManager` and `chooseBatchSettlement` / `offerFromTerms`;
  - the voucher claim builders;
  - the claim-state challenge signers (`signEvmChallenge`, `signSolanaChallenge`);
  - the exit builders;
  - `FacilitatorError` and `SponsorRefusedError`.
- **Chain building blocks:**
  - on Base, the EVM channel config and id, and the ERC-3009 and Permit2 deposit builders;
  - on Solana, the channel PDA, and the `open` and `top_up` instructions.
- **Wire vectors** at `schema_version` 7, replayed as the conformance suite: `claim_voucher`, `charge`, `voucher_claim_state_challenge`, `client_auth_channel_challenge` and the refused `toon-channel` shapes.

### Fixed

- A metered route priced near the top of the range now saturates at `u64::MAX`, as the connector does. Before, it quoted an amount no voucher can carry.
