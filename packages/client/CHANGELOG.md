# @toon-protocol/client

## 0.21.0

### Minor Changes

- 1307ee9: Zero-config devnet: baked defaults for a fresh install, a `rig entry` switch,
  and per-pair Mina zkApp auto-deploy.

  rig:

  - `rig fund` on a completely fresh install (no config, env, or git-origin
    anywhere) now infers devnet from core's committed genesis seed and drips —
    `npm i -g @toon-protocol/rig && rig fund` works with zero config. Any
    configured origin (devnet or not) still suppresses the seed, so an explicit
    or deliberately non-devnet setup keeps its exact semantics (#288).
  - `rig name buy`/`rig name set` default `--via` to the deployed devnet store
    DVM when BOTH the ArNS `--network` and the TOON network resolve to devnet;
    the new `--direct` flag opts out (and also suppresses `RIG_ARNS_DVM_URL`).
  - `rig channels` — shorthand for `rig channel list`.
  - New `rig entry <apex|sandbox|url>`: switch the network entry node (payment
    ingress + relay) with the devnet sandbox endpoints baked in. Mutations
    clear the topology cache, remove the legacy `proxyUrl` override, and warn
    about env precedence, per-entry channels, the sandbox's Mina-only
    settlement, and git-origin relay precedence.
  - New `rig channel deploy-zkapp`: pre-deploy this identity's dedicated Mina
    PaymentChannel zkApp ahead of the first paid Mina write.
  - `chain` (and the new verbs) added to the strict-`--json` owned-verb set.

  client:

  - Per-pair Mina zkApp auto-deploy: the Mina `PaymentChannel` zkApp is
    single-pair, so a fresh identity can never open a channel on the shared
    announce/preset zkApp. `minaChannel.autoDeploy` (wired automatically by
    rig's derived config) makes `openMinaChannel` resolve a zkApp that is
    provably owned by this pair — reusing a recorded deployment, including
    crash-recovery of an uninitialized one — and deploy a dedicated zkApp
    otherwise (deploy and initialize stay separate transactions). New exports:
    `deployMinaChannelZkApp`, `ensureOwnedMinaZkApp`. Without `autoDeploy`,
    behavior is unchanged and `zkAppAddress` remains required.

## 0.20.3

### Patch Changes

- 261ac8e: `getWalletBalances` (→ `rig balance`) now reads the Mina settlement **token**
  balance (USDC), not just native MINA.

  The Mina channels are denominated in a custom token, so a token balance needs
  the `tokenId`. `getWalletBalances` now threads `config.minaChannel.tokenId`
  (derived from the announce/core preset by the rig, or set explicitly) into the
  balance read, and `WalletBalanceReader` reads it via the GraphQL
  `account(publicKey, token)` query. Because that query's `TokenId` scalar rejects
  the decimal Field form, a small self-contained encoder converts it to the base58
  `TokenId` (matching o1js `TokenId.toBase58`, without pulling in o1js). A fresh
  client with no explicit `config.minaChannel` therefore shows its Mina USDC
  balance once the derived channel carries a tokenId. Native MINA is still
  reported; both reads are independent and best-effort.

## 0.20.2

### Patch Changes

- cdd7a0c: Drop the temporary local Base Sepolia (`evm:base:84532`) preset overrides now
  that `@toon-protocol/core@3.1.1` ships the corrected public-devnet addresses.

  - Bump `@toon-protocol/core` to `^3.1.1` in `client`, `client-mcp` (both from
    `^3.0.0`) and `rig` (from `^2.0.1`, a major jump), so the correct Base Sepolia
    USDC (`0x49beE1…`, 6-decimal) + TokenNetwork (`0x1E95493f…`) and the corrected
    Solana devnet payment-channel program (`2aEVJ8ko…`) flow straight from the
    package.
  - Remove the `evm:base:84532` correction block (and the `BASE_SEPOLIA_*`
    constants) from the client's `applyNetworkPresets` — the values now come
    directly from core's `base-sepolia` preset.
  - Remove the `BASE_SEPOLIA_PRESET` override (and its early `id === 84532`
    return) from the rig standalone `evmPresetForChain`, letting it fall through
    to core's `CHAIN_PRESETS['base-sepolia']`.

  The relay-default hardening and the `rig fund` USDC-only routes from the prior
  change are unaffected. Completes the follow-up from PR #404 / toon#104.

- 9751296: Point `rig` at the current public devnet/testnet infra instead of dead or stale
  defaults.

  - `rig fund` now funds **USDC only** (assuming the wallet already holds gas) via
    the USDC-only faucet legs (`/api/base-sepolia/request`,
    `/api/solana/usdc-request`, `/api/mina/usdc-request`) instead of the
    deprecated local-anvil `/api/request` leg, and accepts a positional chain so
    `rig fund sol | mina | evm | all` works alongside `--chain` (`sol` aliases
    `solana`).
  - Fix `rig balance` / channel settlement resolving the **wrong Base Sepolia
    token**: the `@toon-protocol/core` `base-sepolia` (`evm:84532`) preset still
    carries the retired e2e deployment (18-decimal USDC, old TokenNetwork), so the
    announce-fallback path read the wrong token at the wrong decimals. Corrected
    the fallback to the current public addresses in both the rig resolution layer
    and the client SDK (`applyNetworkPresets`), pending an upstream core bump.
  - Harden the dead-local `ws://localhost:7100` relay fallbacks to the public
    devnet relay `wss://relay-ws.devnet.toonprotocol.dev` (explicit config still
    wins).

## 0.20.1

### Patch Changes

- 8100f92: Derive the Solana deposit payer ATA instead of requiring it in config. A Solana
  channel deposit previously threw "Solana deposit requires
  solanaConfig.deposit.payerTokenAccount" because callers (rig) never supplied the
  payer's SPL token account — but it is deterministic (the owner's ATA for the
  channel mint), and the client already has both the payer keypair and the mint.
  Adds `deriveAssociatedTokenAccount` and derives the ATA in the deposit and
  open-with-deposit paths when the caller did not pass one.

## 0.20.0

### Minor Changes

- fb7485d: Full v2 EIP-712 domain-separated balance-proof adoption on both the receive AND settlement-build EVM claim paths (refs toon-protocol/connector#324 finding #1). Bumps `@toon-protocol/sdk` + `@toon-protocol/core` to `^3.0.0` (the published v2 EIP-712 packages).

  The v1 EVM claim digest bound neither `chainId` nor the settling contract, so a signer-signed claim could be replayed verbatim on another `(chain, deployment)` for the same tuple. This binds `chainId` + `verifyingContract` into every EVM claim digest via a standard EIP-712 typed-data domain (`name="RollingSwapChannel"`, `version="2"`), making a signature valid on exactly one `(chainId, contract)` pair and failing the v1↔v2 cutover closed.

  - adds a client-local v2 digest module (`swap/evm-claim-digest.ts`: `evmClaimDigest`, `evmCooperativeCloseDigest`, `recoverEvmClaimSigner`, `verifyEvmClaimSignature` + pinned domain/typehash constants) as the client's byte-for-byte conformance anchor, pinned by the spec §4 golden vectors;
  - threads `chainId` (parsed off the chain key) + `verifyingContract` (`tokenNetworks` param) into the receive-side EVM claim verification; an EVM claim missing either input is rejected `MISSING_CHAIN_CONFIG` (fail-closed). Solana/Mina keep the sdk `verifyAccumulatedClaim` path;
  - the settlement-build path (`buildSwapSettlements` → sdk `buildSettlementTx`) now runs on the published v2 sdk, which verifies EVM claims against the same v2 EIP-712 digest. `buildSwapSettlements` threads `chainId` + `verifyingContract` (from `tokenNetworks`) into the sdk signer config, so a v2-signed received claim round-trips through `buildSettlementTx` with settle-time signature re-verification (defense-in-depth) fully restored.

  Breaking: EVM received-claim verification AND settlement build now require `tokenNetworks` per chain key, and the wire digest is v2-only (a v1 signature never validates as v2). Depends on `@toon-protocol/sdk@^3` / `@toon-protocol/core@^3`.

## 0.19.0

### Minor Changes

- c3b34b0: Atomic verify/reveal composition + per-packet preimage retention (rolling-swap leg-B, toon-client#360, part of toon-meta#145)

  Two coupled rolling-swap seams that leg-B reveal (spec §3.2) needs:

  - **Preimage retention.** `withSenderConditions` minted a fresh per-packet
    preimage `P_i`, set `C_i = sha256(P_i)` on the leg-A PREPARE, and then
    discarded `P_i`. It now retains each `P_i` in a session-scoped
    `InMemoryPreimageRetentionStore`, keyed by `packetIndex` — the identifier
    shared with `AccumulatedClaim.packetIndex` — so the receive-side reveal can
    correlate and consume the secret for the claim it commits.
  - **Atomic verify → persist → reveal.** New `ingestAndReveal` composes the
    `ingestReceivedClaims` verification/persist step with the leg-B reveal as one
    unit: a verified claim's watermark advance survives iff its reveal commits,
    and is rolled back (compensating restore of the prior watermark) on
    withhold/failure. This makes the persisted watermark track only
    accepted/revealed packets, so engine R8's reused nonce — the maker reuses a
    rolled-back nonce for the next fill — is accepted, not falsely rejected as
    non-monotonic. The daemon's swap path routes claim ingestion through it.

  Legacy zero-condition swaps and hard verification rejects are unchanged (never
  reach a reveal, never touch a watermark).

- c816641: Mina receive-side swap settlement: co-signed `claimFromChannel` (#357)

  Redeem swapped-in `mina:*` claims on-chain, replacing the `SUBMISSION_UNSUPPORTED`
  fail-closed that #352 shipped. `POST /swap/settle` / `toon_swap_settle` now route
  Mina bundles through a receive-side co-sign path instead of refusing them.

  - `buildMinaCoSignedClaim` (client) assembles a dual-party `claimFromChannel`
    claim from a verified Mina bundle: reads the on-chain channel state via plain
    GraphQL (no o1js), resolves the participant A/B ordering against the stored
    `channelHash`, conserves balances against `depositTotal`, and produces the
    recipient's Pallas-Schnorr co-signature over `[commitment, nonce, channelHash]`
    with `mina-signer`.
  - `submitMinaSettlement` drives the o1js `claimFromChannel` proof + broadcast
    through an injectable submitter (default: a lazy o1js + `@toon-protocol/mina-zkapp`
    settler, so the non-Mina path never loads the WASM circuit runtime).
  - Wired into `ToonClient.settleSwapBundle` and the daemon `settleSwapClaims` seam.

  The on-chain claim is dual-party, so it still needs the maker's
  payment-channel-commitment-form co-signature (the swap-wire claim only carries the
  maker's `balanceProofFieldsMina` signature — a different message). Absent one,
  settlement fails closed with `MINA_MAKER_COSIGN_REQUIRED` after assembling the
  recipient's half. Operators can inject the maker `{ r, s }` via
  `swapMinaMakerSignatures` until it flows over the swap wire.

  Part of toon-protocol/toon-meta#145.

### Patch Changes

- 0eaa65e: De-duplicate `publishEvent`'s inline claim-resolution branch into the shared `resolveClaimForDestination` helper already used by `sendSwapPacket`.

## 0.18.0

### Minor Changes

- 2eb9709: Rolling swap: receive-side claim ingestion, verification, and settlement (#352, part of toon-meta#145).

  The client now VERIFIES every chain-B claim a swap returns instead of accepting it blind: signature against the maker's advertised/pinned `swapSignerAddress` (sdk 2.x `verifyAccumulatedClaim`), chain/recipient consistency, and nonce/cumulative monotonicity against a durably persisted per-`(chain, channelId)` watermark (`received-claims.json`, beside the channel store — survives daemon restarts). A claim that fails verification is never counted as value received: it is rejected loudly and result-shaped (per-claim `verificationError`, `SwapResponse.warning`, `accepted: false` when nothing verified). Legacy no-metadata swaps keep the existing #349 warning path unchanged.

  New settlement drive: `GET /swap/claims` lists persisted watermarks; `POST /swap/settle` (MCP: `toon_swap_claims` / `toon_swap_settle`) builds ONE on-chain close per channel from the final watermark via sdk `buildSettlementTx` (claims re-verified at settle time) and submits it on EVM when `chainRpcUrls[chain]` is configured — the env-gated seam; Solana/Mina return the built tx unsubmitted (Mina receive-side co-sign is an explicit follow-up). `@toon-protocol/client` exports the pipeline (`ingestReceivedClaims`, `buildSwapSettlements`, `submitEvmSettlement`, `JsonFileReceivedClaimStore`) and `ToonClient.settleSwapBundle`. sdk/core bumped to ^2.1.0; ILP transports accept core 2.1's ISO-string `expiresAt`.

## 0.17.0

### Minor Changes

- a6caf80: Rolling-swap prerequisite (#350): transports send a real sender-chosen ILP
  executionCondition and verify the FULFILL preimage.

  - Both ILP transports (`HttpIlpClient` `POST /ilp` and `BtpRuntimeClient` BTP)
    accept an optional 32-byte `executionCondition` and explicit `expiresAt` and
    set them on the wire; the default stays the legacy all-zero condition, so
    existing publish/upload writes are byte-for-byte unchanged.
  - On FULFILL with a non-zero sent condition, the client verifies
    `sha256(fulfillment) == condition` and surfaces a mismatch (or a missing /
    malformed / all-zero preimage) as a FAILED, non-retried packet (code F99) —
    never a silent accept. The FULFILL's 32-byte preimage is now captured from
    the OER wire instead of skipped.
  - `ToonClient.sendSwapPacket` plumbs `executionCondition`/`expiresAt` through
    to whichever transport is active; new exports `mintExecutionCondition`,
    `fulfillmentMatchesCondition`, `isZeroCondition`, `assertValidCondition`,
    and the `IlpSendParams`/`IlpSendResultWithFulfillment` types.
  - Daemon `POST /swap` gains opt-in `senderConditions`: the swap path mints one
    FRESH condition per packet (`C_i = sha256(P_i)`, rolling-swap spec §3 R1/R2).
    Requires a maker + connector implementing the sender-chosen fulfillment
    contract (connector#309); default off.

### Patch Changes

- 488cdbf: Migrate to `@toon-protocol/sdk` ^2.0.0 and `@toon-protocol/core` ^2.0.0 — the
  `mill`→`swap` vocabulary rename (`millSignerAddress`→`swapSignerAddress`,
  `millEphemeralPubkey`→`swapEphemeralPubkey`, `millPubkey`→`swapPubkey`,
  `millIlpAddress`→`swapIlpAddress`; toon commit `af4cd24`, released as
  sdk/core 2.0.0). Rolling-swap prerequisite (toon-protocol/toon-meta#145).

  - `ClientRunner.swap` now calls `streamSwap` with the renamed params and reads
    `swapSignerAddress` directly off accumulated claims (the old
    mill→swap translation shim is gone).
  - **Deploy ordering:** the rename has NO wire back-compat. A pre-rename
    (sdk <2.0.0) swap peer emits `millSignerAddress` in its FULFILL settlement
    metadata, which sdk ≥2's `decodeFulfillMetadata` silently drops — the swap
    "succeeds" but its claims fail later in `buildSettlementTx` with
    `MISSING_SETTLEMENT_METADATA`. Upgrade swap peers (mills) together with
    this client (see toon-protocol/swap#45 / swap#51).
  - New early alarm: `SwapResponse.warning` is set at swap time when accepted
    claims are missing `swapSignerAddress`, instead of failing silently until
    settlement.
  - core ≥2.0.1 ships a seeded `genesis-peers.json` (live devnet apex), so a
    daemon with no relay/destination config now bootstraps from the committed
    seed (`wss://relay-ws.devnet.toonprotocol.dev` / `g.proxy`) instead of the
    `ws://localhost:7100` last-resort fallback.

## 0.16.0

### Minor Changes

- bc1befc: `rig balance`: full multi-chain wallet view — native coin + USDC across EVM, Solana, and Mina (#299)

  `rig balance` previously showed a single number: USDC on the EVM settlement
  chain (and, on the unstarted embedded client, Solana/Mina never appeared at all
  because their keys only derive during a client start). It now renders a per-chain
  block for every chain the identity is configured for — the native coin
  (ETH / SOL / MINA) AND USDC — with the wallet address per chain. A chain with no
  configured token still shows its native balance; an unreachable RPC degrades to a
  per-chain `unreadable (RPC unreachable)` notice without failing the other chains
  (each chain is read independently, in parallel). The command stays FREE (RPC +
  local state reads only) and `--json` grows to
  `{ chain, chainKey, address, native, tokens[] }[]`.

  `@toon-protocol/client` gains `ToonClient.getWalletBalances()` — the comprehensive
  multi-chain reader (native + tokens grouped per chain) — plus native readers
  (`readEvmNativeBalance`, `readSolanaNativeBalance`) and a pure grouped reader
  (`readWalletBalances`), all exported. The existing settlement-scoped
  `getBalances()` is unchanged (payment-channel settlement semantics depend on it).
  `getWalletBalances()` derives the Solana/Mina addresses from the mnemonic on
  demand, so it reports every configured chain even on an unstarted client.

  Follow-up: the daemon/MCP `toon_balances` path still uses `getBalances()`; it can
  adopt the richer `getWalletBalances()` view separately (touches the views atoms).

## 0.15.0

### Minor Changes

- 68a7150: Export `extractArweaveTxId` from the blob-storage helper. Callers that drive
  `publishEvent` directly with a hand-built kind:5094 event (e.g. git-object
  uploads carrying Git-SHA/Git-Type/Repo tags, toon-client#227) can now reuse
  the exact FULFILL→Arweave-txId decode `requestBlobStorage` applies (HTTP
  envelope parse, `accept:false` handling, legacy bare-base64 fallback).
- 1ff6370: Purge pet-game era code and disambiguate "control plane" naming.

  **Breaking (`@toon-protocol/client`):** the pet DVM/marketplace module (`src/pet/`) is removed along with its public exports — `filterPetDvmProviders`, `buildPetInteractionRequest`, `parsePetInteractionResult`, `parsePetInteractionEvent`, `buildPetListingEvent`, `parsePetListing`, `filterPetListings`, `buildPetPurchaseRequest`, and the associated types (`PetDvmProvider`, `PetInteractionRequestParams`, `PetInteractionResultData`, `PetInteractionEventData`, `InteractionResultContent`, `UnsignedNostrEvent`, `StatValues`, `ProofStatus`, `PetListingParams`, `PetListing`, `PetListingFilterOptions`, `PetPurchaseRequestParams`). These were orphaned helpers for the archived pet-game product; nothing in this repo consumes them.

  `@toon-protocol/client-mcp`: docs/comments only — the loopback daemon HTTP surface is now consistently called the "control API" (matching the components table) instead of "control plane", which is reserved for the Rig (the browser-only decentralized control plane). No code identifiers or behavior changed.

## 0.14.12

### Patch Changes

- 0ccd135: Surface an actionable error when the one-time on-chain payment-channel OPEN reverts because the local settlement wallet has no native gas. The client now throws a tagged `ChannelFundingError` (remapped at the origin in `OnChainChannelClient.openEvmChannel`, covering both publish and upload paths) instead of leaking the raw viem "…exceeds the balance of the account" string; the daemon maps it to HTTP 402 `insufficient_gas` (retryable), and the MCP tools surface the "fund the wallet and retry" remedy verbatim instead of a misleading "still bootstrapping" hint. Per-write settlement is unaffected (it rides ILP-over-HTTP and never spends gas) — this only improves the message on the one-time channel-open funding step (toon-meta#65).

## 0.14.11

### Patch Changes

- b243c10: Fix the wallet falsely showing "No channels open yet" on funded channels, and
  make rendered TOON views render-first with no preflight ceremony.

  - **`GET /channels` 500 → wallet "No channels open yet".** `getChannels()`
    called `apex.client.getSettleableAt(channelId)`, but `ToonClient` never got the
    public passthrough when it was added to `ChannelManager` (#181) — it only used
    `this.channelManager.getSettleableAt` internally. The wallet atom renders the
    failed fetch as empty, so funded, actively-paying channels showed as none.
    Added the passthrough, plus a compile-time conformance guard
    (`toon-client-conformance.ts`) asserting `ToonClient` satisfies the daemon's
    `ToonClientLike` surface — the channel-tool tests use a mock client, which is
    why this gap shipped green.
  - **Resumed channels showed 0 deposit / 0 available.** Persisted channel state
    omits the on-chain deposit, so after a daemon restart `depositTotal` was `0`
    and the wallet showed 0 spendable on a funded channel. The daemon now re-reads
    the participant's on-chain `deposit` (new `participants` accessor on the
    TokenNetwork ABI + `ToonClient.rehydrateChannelDeposit`) when resuming an EVM
    apex channel, so `available = deposit − cumulative` is correct again.
  - **Render-first, zero ceremony.** The server `instructions` and the
    `toon_status` / `toon_identity` tool descriptions now state that a read-only
    render goes straight `toon_atoms` → `toon_render` — no status/identity/balance
    preflight, no tool-call narration. SKILL.md's "always start with `toon_status`"
    is reframed to lazy/render-first.

- b243c10: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

## 0.14.10

### Patch Changes

- 48205b0: Wallet balance correctness (#199/#200), async funding, UI auto-refresh, and media posts.

  - Balances: fast-fail with correct error attribution instead of a 35s control-plane hang; always emit wrapped `structuredContent`; the views seam validates the wire contract (no silent blank); read the settlement chain (not the preset-first chain) and from an identity-level client (works with no apex).
  - Funding: async submit+poll `fund-wallet` with a `toon_fund_status` tool, a generous background faucet timeout, and a distinct `timeout` status so a slow-but-successful drip isn't reported as a failure.
  - UI: rendered views auto-refresh after any write action; the Fund button resets once the balance updates.
  - Media posts: captioned media uploader (compose → caption → publish) and an optional media/file attach on the default post composer (kind:1 with NIP-92 imeta, rendered inline); the dedicated uploader remains for upload-only.

## 0.14.9

### Patch Changes

- cb2362b: Rename legacy `town` node-type label to `relay` in comments, docs, and config keys.

## 0.14.8

### Patch Changes

- 686f7a3: Channel withdraw (close → wait → settle) — release collateral from a channel.

  - Client: `OnChainChannelClient.closeChannel`/`settleChannel` (EVM live; reads the
    `channels()` view for the authoritative `closedAt`+`settlementTimeout`).
    `ChannelManager` persists `closedAt`/`settleableAt`/`settledAt` (resumed on
    restart; `signBalanceProof` no longer clobbers them) + `getChannelCloseState`.
    `ToonClient.closeChannel`/`settleChannel` — the settle time guard: never settle
    before `settleableAt` (unix seconds), throwing a retryable error otherwise.
    Solana/Mina close+settle are follow-ups.
  - Daemon: `POST /channels/{close,settle}` (settle-too-early → HTTP 425 retryable),
    `toon_channel_close`/`toon_channel_settle` MCP tools; `toon_channels` now carries
    `closeState`/`settleableAt`.
  - Views: `withdraw-flow` atom — a stepper (Close → Wait → Settle) with a live
    countdown to `settleableAt` and a Settle button gated until the grace period
    elapses; reuses the `progress-steps` stepper.

## 0.14.7

### Patch Changes

- b56fefb: Solana channel deposit (PR B.1).

  Extract `depositSolanaChannel` from the open flow's post-init `deposit`
  instruction and wire it into `OnChainChannelClient.depositToChannel` so
  `toon_channel_deposit` now works on Solana (incremental: the new total is the
  tracked current plus the delta). EVM was added in PR B; Mina deposit (o1js)
  remains a follow-up. No daemon/views changes — that layer is chain-agnostic.

## 0.14.6

### Patch Changes

- d93211a: Add channel deposit (`toon_channel_deposit`) — deposit additional on-chain
  collateral into an open payment channel.

  - Client: `OnChainChannelClient.depositToChannel(channelId, amount, { currentDeposit })`
    with the EVM path live (approve if the allowance is short, then `setTotalDeposit`
    with `current + delta` — the contract takes the cumulative total, not a delta).
    Solana/Mina throw a clear not-yet-supported error (follow-up). `ChannelManager`
    gains `setDepositTotal`; `ToonClient.depositToChannel` reads the current tracked
    deposit, deposits, and updates the tracked total.
  - Daemon: `POST /channels/deposit`, `ControlClient.depositToChannel`, and the
    `toon_channel_deposit` MCP tool (routes to the apex tracking the channel).
  - Views: `deposit-form` atom (channel picker + amount + spendy signed deposit +
    receipt) and the `toon_channel_deposit` write tool on the apps surface.

## 0.14.5

### Patch Changes

- 5838b79: Add wallet + loading/placeholder atoms to the MCP UI.

  - Loading atoms (`skeleton`, `loading`, `progress-steps`) the agent can render
    immediately while it works out the real journey.
  - `wallet-overview` (per-chain address with copy-to-share + on-chain balance
    enrichment + devnet faucet) and `channel-list` (live tracked channels with
    available/deposit balance), backed by new read seams.
  - New free-read tools `toon_channels` (now enriched with `depositTotal` +
    `availableBalance`) and `toon_balances`, plus the `toon_fund_wallet` faucet
    action wired into the apps surface. Client exposes `getChannelDepositTotal`.

- 5838b79: Read live on-chain wallet balances (`toon_balances`).

  Adds a read-only `WalletBalanceReader` (EVM ERC-20 `balanceOf` via viem; Solana
  SPL via `getTokenAccountsByOwner`; native MINA via GraphQL) and
  `ToonClient.getBalances()` — best-effort per chain, no signing or payment. Wires
  it end-to-end through the daemon: `GET /balances`, `ControlClient.balances()`,
  and the `toon_balances` MCP tool. The `wallet-overview` atom's balances now
  resolve live (it already worked from the identity addresses).

## 0.14.4

### Patch Changes

- 83eb81b: Rename legacy vocabulary: the swap-peer node concept is now consistently called "swap" across all packages (part of #134).

  `SwapRequest.millPubkey` → `swapPubkey`, `SwapClaim.millSignerAddress` → `swapSignerAddress`, `TOON_MILL_PUBKEY` env var → `TOON_SWAP_PUBKEY`, ILP address segments updated (e.g. `g.townhouse.swap`), and all prose/doc references updated.

- 9a917f5: Rename non-NIP-90 `dvm` vocabulary to `store` across the repo (issue #139).

## 0.14.3

### Patch Changes

- 26537fd: Make the daemon faucet request timeout chain-aware. The Mina faucet settles much
  slower than EVM/Solana and routinely takes longer than the flat 30s HTTP budget
  to respond even though the drip succeeds server-side, so `toon_fund_wallet({chain:"mina"})`
  reported `Faucet request timed out after 30000ms` on a request that actually
  funded the wallet. `fundWallet` now defaults to 30s for evm/solana and 120s for
  mina (`defaultFaucetTimeout`), and the daemon accepts an explicit override via
  `faucetTimeoutMs` / the `TOON_CLIENT_FAUCET_TIMEOUT_MS` env var.

## 0.14.2

### Patch Changes

- 39beb37: Tolerate the 2-part `evm:{chainId}` chain-key form some connectors advertise (e.g. `evm:31337`), not only the canonical 3-part `evm:{network}:{chainId}`.

  `parseChainId` (`OnChainChannelClient`) and the chainId-from-chainKey parsing in `ToonClient` (peer negotiations + `getChainContext`), `client-mcp/config`, and `apex-discovery` now accept both forms. A mis-parsed 2-part key previously produced `chainId: 0`, which the store connector rejects ("Invalid chainId").

- 5bfae71: Restore the `POST /store` request-target for blob uploads. `buildStoreWriteEnvelope` again accepts a `requestTarget` (default `/write`), `publishEvent` threads a `proxyPath` option through to it, and `requestBlobStorage` passes `/store`. Without this, kind:5094 blob uploads emitted `POST /write` and the Arweave store backend (which serves `/store` + `/health` only) returned 404. Adds a `store-envelope` regression test covering both targets.

## 0.14.1

### Patch Changes

- 68e1a59: Parse the HTTP-over-ILP response carried in an ILP FULFILL packet's `data` on the paid-write and blob-upload paths.

  The deployed connector is a payment-proxy: an accepted ILP FULFILL only means the payment cleared — the FULFILL `data` carries the relay/DVM's verbatim HTTP/1.1 response, so a write can fail inside a successful FULFILL.

  - **Publish (`ToonClient.publishEvent`):** previously reported `success` with a real `eventId` for ANY accepted FULFILL, even when the embedded HTTP status was `404 Not Found` and the event never persisted. It now parses the FULFILL envelope and fails the publish on a non-2xx status (no fake `eventId`).
  - **Blob upload (`ToonClient.uploadBlob` / `requestBlobStorage`):** previously base64-decoded the WHOLE FULFILL data as a bare Arweave tx id, erroring on the real `HTTP/1.1 200 OK ... {"accept":true,"txId":"…"}` body. It now parses the HTTP envelope, JSON-decodes the body, and reads `txId` (falling back to base64-decoding `data`), failing on non-2xx or `accept:false`.

  A shared `parseFulfillHttp` helper backs both paths and falls back to prior behavior for non-HTTP-enveloped FULFILLs (no regression for legacy/non-proxy relays). The MCP daemon's `upload-media` path now surfaces these upload failures instead of returning a fake tx id.

## 0.14.0

### Minor Changes

- 4f51ba1: Add branch 3 of the NIP-on-TOON render trust gradient: the sandboxed mcp-ui `AppRenderer` and the load-bearing **consent invariant** (toon-meta#58, toon-client#90). **Security-sensitive — see the PR for the threat model.**

  **Branch 3 (low trust).** When an unknown kind resolves to a `kind:31036` renderer tagged `m: text/html;profile=mcp-app`, the raw widget HTML is extracted (`extractUiResource` in `@toon-protocol/client`) and rendered inside a hardened, sandboxed iframe via `@mcp-ui/client`'s `AppRenderer` (`SandboxedAppRenderer` in `@toon-protocol/views`). The iframe `sandbox` attribute is overridden to **`allow-scripts` only** — notably _without_ `allow-same-origin` — so the widget runs in an opaque origin and can never reach the host DOM, storage, or the consent surface. `assertSafeSandbox` is a defensive guard against re-enabling any escape token.

  **Consent invariant.** A sandboxed widget may only _request_ an action; it may never _perform_ one or paint the authorization UI. Every `tools/call` the widget requests is classified by the trusted client (`classifyIntent`, default-deny: only a tiny read-only allowlist auto-forwards). Anything state-changing surfaces a host-rendered `ConsentPrompt` drawn **outside** the iframe, using only the client's own audited primitives. The prompt is **non-themeable by construction**: its sole input (`ConsentRequest`) carries no styling/markup field — only a tool name, plain (text-rendered, never `dangerouslySetInnerHTML`) arguments, and a client-fixed `trust: 'low'` that a widget cannot escalate. The action is performed only on an explicit user grant; a denial returns an error to the widget and performs nothing.

  `@toon-protocol/client` gains the framework-agnostic consent module (`extractUiResource`, `classifyIntent`, `buildConsentRequest`, and the `UiResource`/`WidgetIntent`/`ConsentRequest`/`ConsentDecision` types); `@toon-protocol/views` gains the React `SandboxedAppRenderer` + `ConsentPrompt` and the sandbox-hardening helpers. Consumes the branch-3 `McpUiDecision` from `renderDispatch` (#88) and accepts the `fallback: 'mcp-ui'` hand-off from the branch-2 A2UI renderer (#89); the dispatch contract is unchanged. Renderer-swap defense and branch 4 remain #91/#92.

- c22d655: Add branch 4 of the NIP-on-TOON render trust gradient — the generative fallback + optional `kind:31036` publish-back (toon-meta#58, closes #92).

  When a kind is unknown _and_ no resolvable `kind:31036` renderer exists, `GenerativeFallbackRenderer` produces a best-effort, low-trust rendering of the event's shape. The model call is abstracted behind an injectable `RendererGenerator` seam — the host wires its own provider/keys/prompt; this package imports no LLM SDK. A dependency-free `deterministicGenerator` is the default and falls in automatically if an injected model generator throws, so branch 4 always renders _something_.

  Optional **publish-back** republishes the generated renderer as a `kind:31036` addressable event (`d` = target kind, `m` = renderer mimeType, coordinate `31036:<author-pubkey>:<targetKind>`) so the next client has a "known" renderer — branch 4 slowly feeds branch 1. Publish-back is **off by default** and a guarded capability: it only fires when the host passes `publish: { enabled: true, signer, publisher }`. The published renderer is marked curation-pending (`t=generative-fallback`); the namespacing/curation policy is an open epic question and is intentionally not built here.

  Note: `buildUiCoordinate` (and the renderer kind / `ui` tag / coordinate helpers) are imported from `@toon-protocol/core@^1.6.0`, re-exported through `render/constants.ts`. No local mirror.

- c8efd64: Adopt `@toon-protocol/core@^1.6.0` and wire `ui` → `kind:31036` renderer resolution (toon-meta#58).

  The `UI_RENDERER_KIND` (31036) and `UI_TAG` (`ui`) constants mirrored locally in `src/render/constants.ts` for the dispatch skeleton (#88) are now re-exported from the published `@toon-protocol/core` instead; only the render-branch mime selectors (`MIME_A2UI`, `MIME_MCP_APP`), which core does not own, remain local.

  New resolution seam (`src/render/resolveRenderer.ts`) — the piece `renderDispatch` deliberately left out — built on core's pure helpers (`getUiCoordinate` / `parseUiCoordinate` / `selectLatestAddressable`):

  - `resolveUiCoordinate(event)` computes the renderer coordinate. Per the toon#36 decisions the renderer-author pubkey is the **event author**, so the `ui` tag may carry just the bare target kind; a full `31036:<pubkey>:<kind>` coordinate is also accepted but only when its pubkey equals the event author (no third-party renderers).
  - `resolveUiRenderer(event, candidates)` filters the caller-supplied `kind:31036` candidates to that coordinate, picks the latest addressable one (NIP-33 latest-wins), and **re-verifies its signature** with `verifyEvent` before returning it — an unverified renderer is dropped and never reaches the dispatch.

  The relay query that produces `candidates` stays the caller's responsibility, and `renderDispatch`'s contract is unchanged — resolution feeds it.

- 93a712a: Add the kind-keyed render dispatch skeleton + branch-1 native-component registry for the NIP-on-TOON render trust gradient (toon-meta#58).

  `renderDispatch(input, registry)` forks on one question — _do I know this kind?_ — and returns a `RenderDecision` naming the branch and trust tier: branch 1 (known kind → native component, full trust) is wired through the new generic `KindRegistry<C>` (`register`/`lookup`/`has`); branches 2 (A2UI), 3 (sandboxed mcp-ui) and 4 (generative fallback) are routed to clearly-marked decisions for the sibling tickets (#89/#90/#92) to implement. The `m` (mimeType) tag of a resolved `kind:31036` renderer selects the unknown-kind branch (`application/a2ui+json` → branch 2, `text/html;profile=mcp-app` → branch 3).

  Note: the `UI_RENDERER_KIND`/`UI_TAG`/`UiCoordinate` helpers are mirrored locally until they ship in a published `@toon-protocol/core` (blocked on toon#36); the `ui`-tag → `kind:31036` resolution lives outside the dispatch, which consumes an already-resolved renderer.

- 5bbabfa: Add the renderer-swap defense — a fail-closed security guard around render dispatch for the NIP-on-TOON render trust gradient (toon-client#91, toon-meta#58).

  A `kind:31036` renderer is _addressable_: the coordinate `31036:<author-pubkey>:<targetKind>` can later resolve to a different event/`id`. Because the resolved renderer selects both the render strategy and the trust tier, a malicious 31036 that gets selected can attack the user. The new `verifyRendererTrust(...)` guard runs between renderer resolution and `renderDispatch`, and refuses (fails closed — the caller drops to native for known kinds, generative for unknown kinds) on any violation:

  - **Author binding** — the resolved 31036's `pubkey` (and the `ui` coordinate's author segment) MUST equal the event author (the authoritative renderer author per toon#36); cross-author substitution is rejected.
  - **Signature verification** — the 31036 signature is re-verified (`verifyEvent`) before it can select a strategy; tampered/unsigned renderers are rejected (and a throwing verifier fails closed).
  - **Deterministic selection** — candidate revisions are collapsed with `selectLatestAddressable` (latest `created_at`, lowest-`id` tiebreak, NIP-01), so selection is not attacker-race-controllable.
  - **Anti-swap pinning + downgrade detection** — the chosen renderer `id`/trust tier is pinned per coordinate in a `RendererPinStore`; a later differing `id` is a detected swap. A trust-lowering swap is refused; for high-trust (branch-1 known) kinds _any_ `id` change is refused and falls back to the native component. The pin store can be seeded from config to allowlist a high-trust renderer by `event.id`.

  Adds `guardedRenderDispatch(...)` as the secure entry point that wires the guard around `renderDispatch` and never passes a suspect renderer through.

  The `UiCoordinate` helpers (`getUiCoordinate` / `selectLatestAddressable` / `UiCoordinate`) are imported directly from `@toon-protocol/core@1.6.0` (the dep bump landed in #97, which also dropped the local `constants.ts` mirror). The guard shares those primitives with the `resolveUiRenderer` resolver (#97) — so the two agree bit-for-bit on coordinate selection and signature acceptance — and layers the anti-swap pin store plus granular fail-closed rejection reasons on top, rather than re-deriving resolution as a parallel copy.

- 25d0473: Wire the NIP-on-TOON render trust gradient into the live app render path (toon-meta#58). The gradient was previously dead code; it is now the real render path for every incoming event.

  **`@toon-protocol/views` — the gradient is now the live event render path.**

  - `buildKindRegistry()` (in `atoms/registry.ts`) builds the branch-1 `KindRegistry<Atom>` from the catalog's atom→kind metadata — the registry `guardedRenderDispatch` consults first. The generic fallback atom is deliberately not registered, so an unknown kind misses and falls through to the unknown-kind branches.
  - A new renderer resolver (`render/resolve.tsx`): `useRenderDecision(event, bridge, registry, pins)` runs the gradient per event. Known kinds short-circuit to branch 1 (native) with no relay round-trip; for an unknown kind with a `ui` coordinate it fetches candidate `kind:31036` renderers over the bridge — `toon_query { kinds: [31036], '#d': [targetKind], authors: [eventAuthor] }` — and drives `guardedRenderDispatch` once they arrive (async loading state). `rendererQueryFilter(event)` is exported.
  - `runtime.tsx`'s `EventAtom` (the kindAuto / feed render seam) now switches on the `RenderDecision`: `native` → the atom component (full trust, today's behaviour); `a2ui` → `A2UIRenderer` (medium, with generative fall-through on a gate refusal); `mcp-ui` → `SandboxedAppRenderer` with the host-rendered consent prompt (low); `generative` → `GenerativeFallbackRenderer` (low, deterministic generator; no model is wired in the app and publish-back stays off). Dispatch goes through `guardedRenderDispatch` (not bare `renderDispatch`), so author-binding + signature + anti-swap pinning apply; a session-scoped `RendererPinStore` is seeded at app scope. The explicit atom-by-id ViewSpec path (`NodeView`) is unchanged.

  **`@toon-protocol/client` — browser-safe `./render` subpath.**

  - Adds a `@toon-protocol/client/render` export (and a second tsup entry) exposing just the render trust gradient — pure dispatch + swap-defense + branch helpers that depend only on `@toon-protocol/core`'s `ui` helpers and `nostr-tools`. The views app bundle imports this subpath instead of the package root so the client's Node-only channel/transport code never enters the iframe bundle. No behaviour change to existing `@toon-protocol/client` consumers.

  **`@toon-protocol/client-mcp` — reship the rebuilt bundle.**

  - client-mcp copies `@toon-protocol/views`' prebuilt `dist/app/index.html` into its own `dist/app` at build time and serves it at `ui://toon/app`. A patch bump so a published client-mcp reships the rebuilt, gradient-wired app bundle.

## 0.13.0

### Minor Changes

- 28ba334: Add a `toon_fund_wallet` MCP tool that drips devnet test funds to a wallet from the configured faucet. With no arguments it funds the client's own address on the active settlement chain (the usual "fund me before I open a channel" step); `chain` and `address` can be overridden. It's backed by a new `/fund-wallet` control-plane route on `toon-clientd` (the daemon holds the faucet URL + keys, so the MCP caller needs neither).

  Also enables Solana and Mina in the `fundWallet` client helper. They were previously gated behind a "deferred (WS3)" throw; the deployed devnet faucet now drips all three chains (EVM ETH+USDC, Solana SOL+USDC, Mina native+USDC) with an identical `{ address }` request shape.

## 0.12.0

### Minor Changes

- 703dcd7: Route paid writes through the connector proxy (ILP-over-HTTP) and add devnet config + faucet helper.

  `@toon-protocol/client`:

  - **Transport-agnostic paid-write path.** `publishEvent`, `sendSwapPacket`, and `sendPayment` now route the ILP PREPARE + signed payment-channel claim through the ACTIVE ILP transport instead of hard-requiring a BTP socket. Selection mirrors `modes/http.ts`: the `runtimeClient` (the `HttpIlpClient` `POST /ilp` proxy transport when a `proxyUrl`/`connectorHttpEndpoint` is configured, else the BTP socket) is used when it implements `sendIlpPacketWithClaim`, with the BTP client as fallback. The old `NO_BTP_CLIENT` throw is replaced by a clearer `NO_ILP_TRANSPORT` error when no claim-capable transport is configured. BTP remains fully supported when it is the configured transport. All claim signing/construction is unchanged (claim validation stays connector-only).
  - **New config fields** `proxyUrl` and `faucetUrl` on `ToonClientConfig`. Setting `proxyUrl` (e.g. `https://proxy.devnet.toonprotocol.dev`) derives `connectorHttpEndpoint` (`…/ilp`) so writes route over ILP-over-HTTP, satisfies the `connectorUrl` requirement, and suppresses BTP-url auto-derivation (the proxy edge serves ILP-over-HTTP, not necessarily BTP). New `proxyIlpEndpoint()` helper.
  - **New `fundWallet(faucetUrl, address, chain)` faucet helper** (`faucet.ts`). EVM is implemented (`POST /api/request`, drips ETH + USDC); Solana/Mina throw a clear "deferred (WS3)" error.

  `@toon-protocol/client-mcp`:

  - Daemon config accepts `proxyUrl`/`faucetUrl` (env `TOON_CLIENT_PROXY_URL` / `TOON_CLIENT_FAUCET_URL`) and `TOON_CLIENT_DESTINATION`. A `proxyUrl` now satisfies the uplink requirement (`btpUrl` becomes optional) so the daemon can write through the proxy with no BTP socket. The destination stays configurable (e.g. `g.proxy` for devnet) and is NOT hardcoded as a global default.
  - Added `e2e/devnet.ts`: deployed-devnet endpoint constants + a `TOON_DEVNET_E2E`-gated `fundDevnetWallet()` step that funds the client wallet via the faucet helper before publishing. The normal unit suite never touches the network.

  The eventual home for the devnet endpoints is a `@toon-protocol/core` devnet preset (upstream npm release); they live here as explicit config until that ships.

- 4fa8019: Proxy-mode apex negotiation + per-chain payment-channel creation, enabling paid writes over the connector proxy `POST /ilp` without a BTP socket (issue #69).

  `@toon-protocol/client-mcp`:

  - **Proxy-mode apex negotiation (no BTP).** The daemon now populates the apex's `peerNegotiations` in proxy-only mode (`proxyUrl` set, no `btpUrl`) so `toon_publish` / `toon_open_channel` no longer fail with `Cannot resolve peer for destination: g.proxy`. The negotiation is sourced, in precedence order, from an explicit `apexChains[chain]` / `apex` block, then a negotiation synthesized from the flat settlement config (`settlementAddresses` / `tokenNetworks` / `preferredTokens`), then live `kind:10032` discovery off the relay. The connector's on-chain settlement (counterparty) address is REQUIRED to open a channel and is never fabricated — when it cannot be determined, the runner defers to relay discovery and surfaces the exact missing value via the apex `lastError`.
  - **Lazy, persisted channel open in proxy mode.** Bootstrap injects the negotiation and becomes ready WITHOUT opening the channel, so the wallet can be funded after the daemon starts (the fund → open → publish flow). The on-chain EVM channel is opened idempotently on the first `POST /channels` / paid write, then persisted for restart-resume. BTP mode keeps its historical eager open.
  - **Read-only daemon (no uplink).** `resolveConfig` no longer throws `No uplink configured`; a relay-only daemon starts and serves FREE reads. A write attempt without a proxy/BTP uplink is rejected at the control plane with an actionable "configure an uplink" error (`hasUplink`).

  `@toon-protocol/client`:

  - Paid writes route through the ACTIVE ILP transport selected in `modes/http.ts` (the `HttpIlpClient` `POST /ilp` proxy transport when a `proxyUrl`/`connectorHttpEndpoint` is configured) — no change to claim signing/construction. Payment-claim validation stays connector-only.

  Validated live against the deployed devnet (Anvil chain 31337): the daemon negotiates in proxy mode, funds via the faucet, opens + deposits into an on-chain payment channel against the connector's settlement address, signs a balance-proof claim, and sends it over `POST /ilp`. The connector accepts the HTTP transport and returns a structured ILP response.

- fed33cb: BREAKING: removed the legacy hidden-service / Anyone-protocol (`.anyone` / SOCKS5h) transport overlay.

  The canonical client payment path is now connector-as-proxy over ILP-over-HTTP (`ToonClient.h402Fetch`) with BTP/WebSocket as the duplex session transport. The `.anyone` SOCKS5h overlay is gone.

  `@toon-protocol/client` (minor — pre-1.0 breaking):

  - Removed exports: `startManagedAnonProxy`, `selectAnonAsset`, `ANON_VERSION`, `ANON_ASSETS`, `ManagedAnonProxy`, `StartManagedAnonProxyOptions`, `AnonAsset`, `isRoutableHsHostname`, `assertRoutableHsHostname`, `HS_HOSTNAME_REGEX`, `HS_HOSTNAME_MAX_LENGTH`, and the `ClientTransportConfig` type.
  - Removed `ToonClientConfig` fields: `transport`, `managedAnonProxy`, `managedAnonSocksPort`.
  - Removed modules: `transport/anon-proxy`, `transport/socks5`, `transport/hs-hostname`, `transport/gateway`, `transport/index` (transport resolution).
  - Dropped the optional `socks-proxy-agent` dependency.

  KEPT (unchanged): BTP/WebSocket transport, `h402Fetch` / ILP-over-HTTP, payment channels, balance-proof claim signing, and free relay reads.

  `@toon-protocol/client-mcp` (minor): removed the `managedAnonProxy` / `socksProxy` config knobs, the `TOON_CLIENT_SOCKS` env override, the daemon-managed `.anyone` read proxy, and the `.anyone`-relay auto-detection. The daemon dials `btpUrl` / `relayUrl` directly. Dropped the optional `socks-proxy-agent` dependency.

### Patch Changes

- 94b83dd: Fix `ToonClient.publishEvent` to send the HTTP `POST /write` store envelope on the payment-proxy path.

  The deployed connector is a payment-proxy that terminates paid writes as HTTP-in-ILP: it decodes the ILP PREPARE `data` as a literal HTTP/1.1 request and reverse-proxies it to the relay store's `POST /write`. `publishEvent` previously sent the bare TOON-encoded event as `data`, which has no request-line, so the proxy rejected every paid write with `F01 - Invalid HTTP envelope: malformed request-line`. The high-level `publishEvent` / daemon `/publish` / `uploadMedia` / blob-storage paths (which all funnel through `publishEvent`) were therefore broken against the live store.

  `publishEvent` now wraps the signed event in a `POST /write HTTP/1.1` envelope carrying `{"event": <signed event object>}` as the JSON body (the shape the store's `/write` handler verifies and stores). A shared `buildStoreWriteEnvelope` helper is exported from `@toon-protocol/client`. The TOON encoding is still used to price the write; `sendSwapPacket` (Mill swaps, a raw-TOON contract) is intentionally left unwrapped.

  Also fixes the `client-mcp` `e2e/devnet.ts` apex destination: `g.proxy` F02s ("No route"); the routable store address is `g.proxy.relay.store`.

## 0.11.0

### Minor Changes

- b539273: Add payment-aware HTTP fetch (h402).

  `ToonClient.h402Fetch(url, opts)` is a `fetch()`-like method that makes paying for an HTTP resource transparent: it issues the request, and on `402 Payment Required` parses the x402 `accepts` array, selects the `toon-channel` entry, opens or reuses a payment channel via `ChannelManager`, and sends the raw HTTP request as a transparent HTTP-in-ILP packet to `POST /ilp` via `HttpIlpClient` (claim in the `ILP-Payment-Channel-Claim` header). The FULFILL bytes are reconstructed into a standard Web `Response`, so the caller never sees ILP. When no `toon-channel` entry is offered it surfaces the vanilla x402 challenge unchanged. Transport selection (HTTP vs BTP upgrade) is driven by `selectIlpTransport`; full duplex response streaming is a documented v1 limitation. New `Http402Client` adapter holds the reusable x402-parsing and HTTP-in-ILP framing logic.

  `@toon-protocol/client-mcp` exposes this as the `toon_http_fetch_paid` MCP tool (inputs `{ url, method?, headers?, body?, timeout? }`), routed through the `toon-clientd` control plane (`POST /http-fetch-paid`) to `ToonClient.h402Fetch`, returning `{ status, headers, body }`.

## 0.10.0

### Minor Changes

- 7c4a34d: Add an ILP-over-HTTP (RFC-0035) client transport. `HttpIlpClient` sends one-shot writes via `POST /ilp` (OER PREPARE body, `ILP-Payment-Channel-Claim` header carrying the same claim bytes as the BTP path) and parses the FULFILL/REJECT from the 200 response, with an `upgradeToBtp()` path that opens a `btp`-subprotocol WebSocket carrying HTTP-proven identity. `initializeHttpMode` now selects `HttpIlpClient` when a connector advertises an HTTP endpoint (via the new `connectorHttpEndpoint` / `connectorSupportsUpgrade` config) and falls back to BTP otherwise. Backward compatible: with no HTTP endpoint configured, behavior is unchanged.
