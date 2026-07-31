---
'@toon-protocol/client': minor
---

Fix three defects in the Solana channel-open / greeting-negotiation path.

**The Solana open now collateralizes the channel** (toon-protocol/connector#646).
`OnChainChannelClient.openSolanaChannel` consulted only `solanaChannel.deposit`
— an operator-only override nothing on the rig/daemon/preset path ever sets —
and dropped `OpenChannelParams.initialDeposit` on the floor. So a negotiated
open submitted `initialize_channel` and skipped the `deposit` instruction: the
channel PDA existed, the connector accepted signed claims against it, and the
on-chain vault held 0. Those claims were uncollateralized and could not be
redeemed for value. The open now locks `initialDeposit` — the SAME amount and
the same single policy the EVM opener uses (`negotiation.initialDeposit ??`
`ChannelManagerConfig.initialDeposit`, default `'100000'`) — pulled from the
payer's derived ATA, and reports the resulting vault balance as `depositTotal`
for display and logging (reporting only; nothing gates spending on it). An
ALREADY-OPEN channel is topped up to the same target rather than skipped, so
channels opened before this fix stop signing unredeemable claims. A short or
absent token account, or a wallet without the native SOL for rent and fees,
fails BEFORE any transaction with an actionable `ChannelFundingError` instead of
half-opening a rent-paying, 0-collateral channel.

**The open honours the greeting's `programId`** (#473). The open ran against
config `solanaChannel.programId` while the claim's metadata reported the
greeting's — a divergence would have opened a channel on one program and
asserted another. `OpenChannelParams.tokenNetwork` now selects the program, as
`OpenChannelParams.token` already selected the mint, and the cached channel
context records both the program and the mint actually used so a later deposit
addresses this channel's vault and this channel's payer ATA.

**Solana funding problems are named, not masked** (#474). A two-chain greeting
facing a Solana-funded client with no `solanaChannel` config used to select EVM
silently (`getBalances` cannot see Solana without that config) and die with a
generic EVM funding error; the error now names the missing `solanaChannel`
config as the likely fix whenever the greeting advertised a Solana leg.
`walletPrefersSolana`'s doc no longer claims to weigh native SOL, which it never
read — that check now lives where it belongs, in the open's funding preflight.

---

**MIGRATION — `initialDeposit` and `settlementTimeout` are now honoured.**

`ToonClientConfig.initialDeposit` and `settlementTimeout` were documented, but
`ToonClient.start()` built its `ChannelManager` with no config, so both were
accepted and **silently ignored** — every channel open used the built-in
defaults (`'100000'` base units, 86400 seconds). They now take effect, on EVM as
well as Solana.

If you set either field, check its value before upgrading:

- `initialDeposit` is in the **settlement token's base units** (6-decimal USDC:
  `'100000'` = 0.10 USDC). It is not a native-coin amount and never in wei.
- This package's README previously showed
  `initialDeposit: '1000000000000000000', // 1 ETH in wei`. That was inert; it
  is now a 1e18 base-unit ERC-20 deposit — a trillion USDC — which will revert
  and hard-fail the channel open. Remove the field to take the default, or set
  the amount you actually mean.
- Unset fields are unaffected: the defaults are exactly what every client was
  already getting.
