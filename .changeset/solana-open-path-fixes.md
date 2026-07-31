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
payer's derived ATA, and reports it as `depositTotal` so the tracked spendable
balance is real. `ToonClientConfig.initialDeposit` / `settlementTimeout` are now
actually threaded into `ChannelManager` (they were accepted and silently
dropped), so the collateral is configurable on every chain. A short or absent
token account fails BEFORE any transaction with an actionable
`ChannelFundingError` instead of half-opening a rent-paying, 0-collateral
channel.

**The open honours the greeting's `programId`** (#473). The open ran against
config `solanaChannel.programId` while the claim's metadata reported the
greeting's — a divergence would have opened a channel on one program and
asserted another. `OpenChannelParams.tokenNetwork` now selects the program, as
`OpenChannelParams.token` already selected the mint, and the cached channel
context records the program actually used so a later deposit targets the same
one.

**Solana funding problems are named, not masked** (#474). A two-chain greeting
facing a Solana-funded client with no `solanaChannel` config used to select EVM
silently (`getBalances` cannot see Solana without that config) and die with a
generic EVM funding error; the error now names the missing `solanaChannel`
config as the likely fix whenever the greeting advertised a Solana leg. A
Solana open also preflights native SOL for rent + fees, so a wallet holding USDC
but no SOL fails with an actionable message instead of mid-open.
