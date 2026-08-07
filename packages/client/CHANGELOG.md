# @toon-protocol/client

## 0.29.3

### Patch Changes

- d8f7dce: Resolve a connector's identity by the destination it TERMINATES, not by whatever endpoint the client happens to be posting to (issue #526).

  `ToonClient.publishEvent` used to fetch `GET /ilp/identity` from the posting
  edge and seal the packet to that key. That is correct only when the posting
  edge also terminates the destination, which stops holding for a forwarded
  ILP prefix — the client paid, then was rejected `F01 gift wrap could not be
opened` at the real terminator, since the payload was sealed to the wrong
  key.

  `ToonClient` now resolves `destination` against every peer discovered via
  kind:10032 (not just direct peers — a forwarded prefix's terminator need not
  be one), matching against `ilpAddresses`/`ilpAddress` with the longest
  (most-specific) claim winning and ties broken toward the address's primary
  announcer. It then fetches identity from that announce's `httpEndpoint`.
  Falls back to the posting edge when nothing discovered claims the
  destination, preserving existing behavior for a destination the posting node
  terminates itself.

  **Fix-up (issue #533, PR #531 review):** two follow-on defects in the above.

  1. A discovered announce's `ilpAddresses` array can legitimately claim a
     prefix (e.g. a router announcing `g.toon`) that a DIFFERENT node — never
     discovered, or whose own more-specific announce simply expired — actually
     terminates (e.g. the store at `g.toon.ario`). The `.`-separated ANCESTOR
     match alone used to be enough to make that router a candidate terminator
     for a prefix it does not own. An ancestor (non-exact) match is now only
     trusted when the peer used the pre-Epic-7 legacy form (a single
     self-declared `ilpAddress`, no `ilpAddresses` array) — Epic-7's
     `ilpAddresses` lists every address a peer is reachable AT ("one per
     upstream peering"), a routing fact, not a namespace-ownership claim.
  2. Once a discovery tracker exists, a destination none of its discovered
     peers claims now throws a distinct `TERMINATOR_UNRESOLVED` `ToonClientError`
     instead of silently falling back to the posting edge — refusing to
     publish beats sealing a payload to a key that cannot open it. This
     includes a tracker that has discovered zero peers: that is not evidence
     the posting edge terminates the destination, only the absence of evidence
     that anything does, and it is a live production window (not a
     theoretical one) since a started client always constructs a discovery
     tracker — a tracker reporting zero peers is exactly what the startup race
     looks like before the first announce lands. Only the no-tracker-at-all
     fallback, for a client that never wired up discovery, is unchanged: it is
     still the common single-node case this client has always supported, and
     carries no discovery signal at all to fail closed on.

  `@toon-protocol/client-mcp` is bumped alongside `client` because it inlines
  `client` at build time via a `devDependency` (tsup `noExternal`), and
  changesets does not release a dependent through a `devDependency` — the same
  gap that shipped 0.36.5's stale genesis seed and needed a second bump for
  `#527`.

## 0.29.2

### Patch Changes

- 0da6412: Resolve `@toon-protocol/core` at `^3.2.1` and `@toon-protocol/sdk` at `^3.1.6` (previously `^3.2.0` / `^3.0.0`), so shipped clients pick up toon#165's fix: `resolveClientNetwork` and `createNode`'s default `settlementInfo` now emit the bare `evm:<chainId>` settlement identifier the live fleet and the x402 greeting actually use, instead of the family-qualified `evm:base:<chainId>`.

  `client-mcp` inlines `core`, `sdk`, and the workspace `rig` at build time (`tsup`'s `noExternal`), so — same failure mode as the `0.36.5` stale-genesis-seed incident — a satisfiable dependency range alone does not move the shipped bundle. Bumping the range in `client`, `client-mcp`, and the workspace-only `rig` (which `client-mcp` pulls in via `workspace:*`) and republishing is what actually rebakes the fix into the artifact Claude Desktop and Claude Code run.

  Without the family segment, chain-key equality is now exact between the client's default settlement chains and the apex's `kind:10032` announce, so negotiation no longer silently falls through to `solana:devnet` (the original #165 symptom: a misleading "Solana settlement wallet holds 0 lamports" error that pointed at funding when the cause was identifier format).

## 0.29.1

### Patch Changes

- ff4a763: Resolve `@toon-protocol/core` at `^3.2.0` so shipped clients bootstrap against the live devnet apex.

  `client-mcp` inlines the genesis peer seed at build time, so the published
  `0.36.5` bundle carried `core@3.1.4`'s retired values — `3f12da6d…` (the
  decommissioned TypeScript connector's nostr key), `g.proxy`, and the root-path
  BTP endpoint. `ToonClient`'s bootstrap filter is author-pinned, so it discarded
  the live announce from the current announcer and could not discover the apex at
  all. Raising the range to `^3.2.0` (in `client`, `client-mcp` and the workspace
  `rig`) makes the build bake `30fdd01d…` / `g.toon` / `…/ilp/btp` instead.

  `client` itself does not inline the seed — it reads it from `core` at runtime —
  but its range is raised too so the corrected seed is an explicit requirement
  rather than something a consumer's resolution happens to satisfy.

## 0.29.0

### Minor Changes

- 58a0c7d: Declares the client's payment channel on its BTP session, so a connector can credit an earning agent (toon-client#513, connector#790). The connector previously learned the `session -> channel` association only from an inbound claim — i.e. only when the client **paid** — so a client that only serves paid increments (earns) was never credited: `"no channel is associated with this session yet -- crediting nothing"`.

  `IsomorphicBtpClient.authenticate()`'s greeting now carries an optional `channel` declaration — `channelId`/`channelAccount`, `expires`, and a `signClaimStateChallenge` signature over them, the same domain-separated scheme `POST /ilp/claim-state` already uses to prove channel ownership without moving value or advancing a nonce, so it can never be replayed as a payment. `ToonClient.openChannel()`/`adoptChannel()` now declare the channel on the live BTP session via a new `IsomorphicBtpClient.reauthenticate()`/`BtpRuntimeClient.reauthenticate()` (re-sends the auth greeting on the existing session — no socket reconnect), and a reconnect's own greeting re-declares it automatically. Both EVM (`EvmSigner.signClaimStateChallenge`) and Solana (`SolanaSigner.signClaimStateChallenge`) channels are covered; Mina is out of scope, matching `getClaimState`'s existing evm/solana-only posture. A client with no channel yet, or one talking to a connector that doesn't understand the new greeting fields, authenticates exactly as it did before — fully additive.

## 0.28.0

### Minor Changes

- 037886a: Surface the x402 `accepts[0].extra` bag — starting with `session_lease_ttl_ms` (connector#722) — on `ConnectorRouteTerms` too, matching the posture #506/#507 established for `Http402Client`. `ConnectorEdgeClient.getRouteTerms`/`parseConnectorRouteTerms` is the parser ordinary channel bootstrap (`publishEvent`/`openChannel`/`adoptChannel`) actually negotiates through, so `session_lease_ttl_ms` is now readable via `ToonClient.getLastConnectorRouteTerms()` without a caller having to issue a separate `h402Fetch` probe purely to populate a cache. `extra` is an open bag: unknown keys survive, and it is `undefined` — not a default — when the peer sends none. Existing `settlement`/`settlements` extraction (connector#632) is unchanged.

## 0.27.0

### Minor Changes

- 9c15a0f: Surface the x402 `accepts[0].extra` bag — starting with `session_lease_ttl_ms` (connector#722) — on `ToonChannelAccept`/`ParsedX402Challenge`, so a caller can read it via `parseX402Body`/`parseX402Challenge` or, after a call to `ToonClient.h402Fetch`, via the new `ToonClient.getLastX402Terms()`. `extra` is an open bag: unknown keys survive, and it is `undefined` — not a default — when the peer sends none.

## 0.26.2

### Patch Changes

- 993acef: Fix BTP/HTTP-ILP clients defaulting `peerId` to the literal string `"client"` when `btpPeerId` is unset — every client collided under the same connector `SessionRegistry` key, making a bound provider unaddressable (connector#736/#743). Both `initializeHttpMode` call sites now default to the client's own `ilpInfo.ilpAddress` instead, with an explicit `config.btpPeerId` still taking precedence.

## 0.26.1

### Patch Changes

- f8263a9: Fix `network: 'devnet'` never negotiating EVM (issue #500): the devnet preset names its EVM chain in the family-qualified form (`evm:base:84532`, from `@toon-protocol/core`'s `resolveClientNetwork`), but the live devnet apex's `kind:10032` announce uses the unqualified form (`evm:84532`). Exact-string chain matching in `ToonClient`'s lightweight bootstrap-fallback negotiation never intersected the two sets, so it silently skipped EVM and negotiated `solana:devnet` instead — a chain nobody asked for, surfacing several layers later as an unrelated "empty Solana balance".

  `matchNegotiatedChain` now compares chains by numeric chain id (`evm:base:84532` and `evm:84532` name the same chain; only the id disambiguates on-chain) instead of exact string equality, and returns the peer's own chain string so peer-side settlement maps still resolve correctly. When no common chain exists at all, it now throws `CHAIN_NOT_SUPPORTED` naming both the client's and the peer's supported chains, instead of silently falling back to a different chain.

## 0.26.0

### Minor Changes

- 05ec8fc: Add `BtpPaidWriteTransport` (issue #482): a persistent, strictly-ordered BTP
  transport for paid writes, built on the connector's client-facing BTP
  websocket ingress (client-edge-spec.md §1.9). It wraps a `BtpRuntimeClient`
  session to give:

  - a persistent socket, connected once and reused across many writes instead
    of the per-call open/close pattern `Http402Client.upgradeToBtp()` uses;
  - strictly ordered claim dispatch — writes are enqueued FIFO and the next one
    is not sent until the previous has settled, which is what lets a burst of
    paid writes on one channel avoid racing itself into `F01
NonceNotAdvancing` (measured on the huddle-over-ILP prototype: 0 F01
    rejects across 4,156 events at a sustained 50fps);
  - reconnect-and-resume on a connection-level failure, without losing a
    write's place in the queue or reordering the writes behind it;
  - automatic fallback to a configured HTTP transport once the reconnect
    budget for one write is exhausted.

  `ToonClient` gets a new opt-in `preferBtpForPaidWrites` config flag (default
  `false`) that routes `publishEvent`/`sendSwapPacket`/`sendPayment` through
  this transport instead of the default stateless HTTP one-shot path, when a
  `btpUrl` is configured. The default is unchanged: paid writes keep going
  through HTTP unless a consumer explicitly opts in for a paid-write burst
  (the motivating case is relay-native huddle audio, which needs sustained
  strictly-ordered writes).

- 5197f47: BTP client: accept server-originated MESSAGE and TRANSFER (issue #493, toon-meta#262 "agents earning"). The client dialect (`btp/protocol.ts`) was asymmetric — it only ever sent MESSAGE and resolved the reply through `pendingRequests`, so an agent behind NAT could spend but never be paid or handed a job. RFC-0023 says both sides "play identical roles" after auth; connector issue #697 landed the symmetric grammar server-side, and this closes the client half.

  Adds `BTPMessageType.TRANSFER` (type 7, `amount` + `protocolData`, byte-compatible with `crates/connector-client-edge/src/btp.rs`'s own unit vectors — no ILP-packet field in either direction) to `serializeBtpMessage`/`parseBtpMessage`, and `ERROR`-frame serialization (previously decode-only). `IsomorphicBtpClient` gains `onMessage`/`onTransfer` config handlers: a server-originated request is dispatched to the handler and answered with a RESPONSE/ERROR under the same requestId — never through `pendingRequests`, which only ever correlates this client's own outbound sends (the two id spaces are distinguished by BTP frame type, not by whether an id value collides). An unset `onTransfer` still gets an empty RESPONSE ack, mirroring the connector's own default; an unset `onMessage` is dropped unanswered, matching the pre-#493 dialect exactly. `onInboundError` surfaces in-flight inbound work orphaned by a disconnect instead of it silently vanishing. `BtpRuntimeClientConfig` threads all three handlers through on both `connect()` and `reconnect()`, since a reconnect constructs a fresh `IsomorphicBtpClient`.

  Additive throughout: a client that never sends TRANSFER and is never sent a server-originated MESSAGE behaves exactly as before.

- d54324c: Add the earning API (issue #494, toon-meta#262 "agents earning"): serve paid jobs over BTP and read the credited balance.

  Serve-side: `ToonClientConfig.jobHandler` registers a plain function for a connector-originated BTP MESSAGE carrying a PREPARE (RFC-0023 symmetric grammar, #493) — the handler stays payment-oblivious (no amount/payer/chain parameters), receives the job's opaque `data`, and returns the fulfillment preimage it already minted via `encryptArtifact`/`fulfillIncrement` (#495). A handler that throws, or whose fulfillment does not satisfy the PREPARE's condition, answers `F99` (RFC-0027's own "Application Error" code); an already-expired PREPARE is refused `R00` without invoking the handler. New `btp/protocol.ts` codec: `deserializeIlpPrepare`, `serializeIlpFulfill`, `serializeIlpReject`.

  Read-side: `ToonClient.getClaimState()` asks the connector's `POST /ilp/claim-state` (client-edge-spec.md §1.10) for the netted deposit/claimed/available/nonce position of one or more tracked channels — the same runway source of truth `#261` already established, never a self-reported figure (decision 4/15 forbid agent-published money reports). Adds `EvmSigner.signClaimStateChallenge` (EIP-712, distinct typed struct from a real balance-proof claim) and `SolanaSigner.signClaimStateChallenge` (Ed25519 over a tagged, length-distinct message) so a captured read-only challenge can never be replayed as a payment.

- a3f9e09: Resume the EVM payment channel across restarts instead of opening (and funding)
  a new one every time (toon-client#489).

  `ChannelManager` only knew a peer's channel **in memory**, so a restarted
  process re-entered the lazy-open path and called `TokenNetwork.openChannel`
  again — which mints a fresh `bytes32` per call, stranding the previous
  channel's collateral. Solana never showed the bug only because its channel id
  is a deterministic PDA: the re-open re-derived the SAME channel and
  `trackChannel` rehydrated the watermark from the store. Live measurement runs
  burned ~20 USDC of collateral per run in abandoned EVM channels (~560 USDC
  across 28) while the Solana runs reused 16 channels across 12 runs with zero
  new opens.

  `channelStorePath` now persists a peer→channel **binding** (which on-chain
  channel this identity holds with a peer, per chain + token network) in a
  sibling file — `channels.json` → `channels.peers.json`; the watermark file
  keeps its existing schema. `ensureChannel` consults it before opening
  anything on-chain and re-attaches to the recorded channel **with its
  nonce/cumulative watermark**, so claims continue above the last one the
  connector saw. A binding whose watermark is missing is a hard
  `ChannelResumeError` rather than a silent nonce reset (which would have every
  later claim rejected); a channel already in the withdraw flow is not resumed.
  `ChannelManager` also keys channels per peer AND chain AND token network, so a
  peer settled with on two chains no longer hands back the wrong chain's channel.

  New API: `ToonClient.adoptChannel(destination, channelId)` binds an
  already-open channel for hosts that persisted the id themselves (the MCP
  daemon's apex-channel store, rig's channel map) — tracking alone left the
  lazy-open path unaware, so their first paid write after a restart still opened
  a second channel. `OnChainChannelClient.adoptChannel()` re-seeds the on-chain
  context so a resumed channel can also be deposited into and closed.
  `InMemoryChannelStore` is exported for tests and short-lived processes.

  Also hardens the EVM open against a **stale-read RPC**: `https://sepolia.base.org`
  is a load balancer whose replicas can serve state predating a confirmed
  `openChannel`, making the follow-up `setTotalDeposit` revert
  `InvalidChannelState()` (`0xf806e9d9`) and leaving an uncollateralized channel.
  The opener now polls the channel back before depositing, retries that specific
  revert, and otherwise fails with an actionable `StaleRpcReadError` naming a
  consistent endpoint (`https://base-sepolia-rpc.publicnode.com`, which core's
  `base-sepolia` preset already carries). Tunable via
  `OnChainChannelClientConfig.readConsistency`.

  `@toon-protocol/client-mcp`: the daemon's resume path now calls
  `client.adoptChannel()` after re-tracking its saved apex channel.

- 949768f: Add hashlock delivery helpers (issue #495, toon-meta#262 decision 5): `encryptArtifact`, `fulfillIncrement`, `decryptArtifact`, and `buildIncrementPrepare`, symmetric between the provider and buyer sides of a factory-job increment (`docs/factory-job-protocol.md` §4 in toon-meta).

  The provider encrypts an increment's artifact under a freshly minted 32-byte key and sets the ILP `executionCondition` to `sha256(key)`; the only way to claim the increment's payment is to reveal `key` as the fulfillment, which is the same instant the buyer can decrypt. `encryptArtifact` takes only the artifact bytes — no caller-supplied key or condition — so the condition can never be derived from anything other than the key that actually decrypts the artifact. `decryptArtifact` verifies `sha256(key)` against the condition the buyer paid before decrypting, throwing `HashlockConditionMismatchError` on a mismatch or `HashlockDecryptError` on a tampered ciphertext; neither error ever carries the key.

- 5e28f05: Add a NIP-59 gift-wrap unwrap primitive (toon-meta#256), so external agent
  processes (buzz#19's agent-members) can receive gift-wrapped channel keys
  addressed to the daemon's own Nostr identity without its secret key ever
  leaving the daemon.

  `@toon-protocol/client` gains `ToonClient.unwrapGiftWrap(wrap)`: decrypts a
  kind:1059 gift wrap's two NIP-44 layers with the client's own identity key
  (nostr-tools `nip44`, no hand-rolled crypto) and returns the decrypted rumor
  plus the kind:13 seal's SIGNATURE-VERIFIED signer pubkey
  (`GiftWrapAddressError` / `GiftWrapDecryptError` on failure). Callers must
  read authorship off the seal, never off the wrap's ephemeral, one-time-use
  `pubkey`.

  `@toon-protocol/client-mcp`'s daemon control API adds `POST /nip59-unwrap`
  (body `{ wrap }` → `{ rumor, sealPubkey }`; 400 malformed/wrong-kind/wrong-
  recipient, 422 decrypt/verification failure) plus a matching
  `ControlClient.nip59Unwrap()` method.

- 98106f6: Add `ToonClient.sendTransfer()` (issue #491): a plain, non-custodial send of the
  settlement token or native gas from the caller's own key to an arbitrary
  address, on evm/solana/mina. `@toon-protocol/client` was built around payment
  channels, not transfers — this is the missing primitive underneath
  provisioning a buzz agent (toon-protocol/buzz#74): the owner's treasury has to
  fund a freshly-derived agent address with USDC and native gas before that
  address can open a channel.

  Every send is confirmed by an OBSERVED balance delta at the destination, never
  by the send call/transaction merely landing — the devnet faucet's Solana leg
  has been seen returning success with a real transaction signature while
  delivering 0 lamports (toon-protocol/connector#691); a send that trusted its
  own receipt would report a funded agent that in fact holds nothing.

  New typed errors distinguish preflight failures from delivery failures:
  `InsufficientBalanceError`, `UnknownChainError`, `InvalidAddressError` (all
  checked before anything is submitted), `TransferNotDeliveredError` (accepted
  on-chain/by-node but the destination balance never moved), and
  `TransferUnsupportedError` (a chain/asset combination not implemented yet —
  currently the Mina settlement token; native MINA is unaffected).

  The standalone `sendTransfer()` function and its config/result types are also
  exported from the package root for callers that want to build a
  `TransferConfig` outside a `ToonClient`.

### Patch Changes

- 473b917: Fix #485: `ToonClient.getDefaultChainContext()` always picked
  `supportedChains[0]`, ignoring any explicitly configured settlement chain. On
  a multi-chain devnet announce this silently pinned a daemon configured for
  `evm` (`TOON_CLIENT_CHAIN=evm`) to Solana whenever Solana happened to sort
  first (buzz#47), leaving self-serve onboarding on a chain the user didn't
  choose and may have no gas on.

  `ToonClientConfig` gains an optional `preferredChain` field (`'evm' |
'solana' | 'mina'`). When set, `getDefaultChainContext()` and the lightweight
  bootstrap-fallback chain negotiation (`ToonClient.matchNegotiatedChain`, the
  same one-line `X.find(...) ?? X[0]` pattern) now honor it — matching by chain
  family regardless of `supportedChains` array order — and throw a clear
  `CHAIN_NOT_SUPPORTED` error naming both the configured chain and the
  available chains when no match exists, instead of silently substituting a
  different one. Leaving `preferredChain` unset keeps the previous
  `supportedChains[0]` fallback unchanged.

  `@toon-protocol/client-mcp`'s daemon config now threads the resolved
  `TOON_CLIENT_CHAIN` env var / `chain` config file field into
  `toonClientConfig.preferredChain` — but only when it was actually set
  explicitly, distinct from the `chain` variable's own silent `'evm'` default
  used for apex-negotiation selection — so an unconfigured daemon keeps the
  legacy fallback behavior.

## 0.25.1

### Patch Changes

- f16918e: Rebuild against `@toon-protocol/core@3.1.4` so the bundled devnet genesis peer
  carries the apex's rotated announce identity.

  `core` is bundled into `client-mcp`'s published bundle at build time, so a
  dependency bump alone does not reach users — the package has to be rebuilt and
  republished for the new genesis pubkey to ship. This release does that.

## 0.25.0

### Minor Changes

- 4dbd9cc: `negotiateFromGreeting` now bootstraps a channel on Solana, not only EVM
  (issue #470): a wallet holding only Solana devnet assets can open a channel
  and sign Ed25519 claims against a settling connector it has never announced
  to or registered with, exactly as an EVM wallet already could.

  The x402 greeting's additive per-chain `settlements` list (connector #632)
  is parsed alongside the legacy EVM-shaped `settlement` object — untagged on
  the wire, disambiguated structurally (`tokenNetworkRegistry` names an EVM
  entry, `programId` a Solana one). When a two-chain greeting carries both, the
  EVM leg is still preferred by default; Solana is opened instead only when
  the wallet holds Solana settlement funds and holds none on EVM. A
  Solana-only greeting (no EVM leg at all) always opens Solana. An EVM-only
  greeting — legacy shape or a one-entry `settlements` list — is unaffected.

  The Solana channel-open and Ed25519 claim-signing machinery itself
  (`ChannelManager`, `SolanaSigner`, `OnChainChannelClient`) already existed;
  this wires the greeting-driven bootstrap path into it.

- dcf3763: Fix three defects in the Solana channel-open / greeting-negotiation path.

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
  channels opened before this fix stop signing unredeemable claims — measured
  against this payer's OWN on-chain `deposit_a`/`deposit_b`, which is what bounds
  redeemability, not the vault's token balance (the vault holds both
  participants', so a peer-funded vault can look full while our own collateral is
  0). A channel that is closed or settled is returned unchanged, since the program
  only accepts a deposit on an open one. A short or absent token account, or a
  wallet without the native SOL for rent and fees, fails BEFORE any transaction
  with an actionable `ChannelFundingError` instead of half-opening a rent-paying,
  0-collateral channel.

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

  ***

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

## 0.24.0

### Minor Changes

- 56c6cb0: Rig defaults to the official Rust edge, and the client can bootstrap a
  payment channel with no announce at all.

  **Client — announce-less channel bootstrap (connector #617).** When a paid
  write reaches a destination no announce or registration ever negotiated,
  the client now asks the route itself: `ConnectorEdgeClient.getRouteTerms`
  sends a claimless PREPARE and reads the x402 greeting, and a settling
  connector's greeting carries the channel-opening facts (chain, counterparty
  settlement address, TokenNetworkRegistry, resolved TokenNetwork, token,
  decimals). `ToonClient` synthesizes the `PeerNegotiation` from those facts
  and opens the channel exactly as an announced peer's would have been. A
  greeting without settlement facts keeps the precise `PEER_NOT_NEGOTIATED`
  error — now thrown as itself rather than wrapped in `PUBLISH_ERROR`.

  **Rig — the official edge is the default uplink (connector #616).** With no
  explicit entry (`rig entry <url>` / `rig entry sandbox` / `TOON_CLIENT_*`
  env), paid writes now go to the official TOON relay implementation — the
  Rust connector at `https://proxy.devnet.toonprotocol.dev/rust/ilp`, route
  `g.toon.relay`. A live announce no longer places the uplink (it still
  informs the destination anchor, routes, prices and bootstrap peers), and a
  price floor from one fleet's announce no longer binds a write that targets
  another fleet's edge.

## 0.23.0

### Minor Changes

- 3148741: Envelope targets are now handler-relative (ADR 0025), which is what makes a
  paid write actually land on the deployed Rust connector.

  The connector resolves an envelope's target STRICTLY BENEATH the route's
  configured handler path (connector #596): `''` means "the handler's own
  path", and an absolute `/write` or `/store` is refused as an escape attempt
  (F00) before the app is ever reached. Until this change every default
  `publishEvent` — and every `Http402Client` fetch — sent an absolute target,
  so the deployed edge refused them all while the suite stayed green (the fake
  connector never enforced the rule; it does now).

  - `publishEvent`: default target `'/write'` → `''`. `proxyPath` is now a
    sub-path resolved beneath the route's handler — the DESTINATION picks the
    endpoint. Callers passing an absolute `proxyPath` must drop the leading
    `/`.
  - `blob-storage`: no longer passes `proxyPath: '/store'`; the store
    destination's route already terminates at the store endpoint.
  - `Http402Client`: targets are the URL path relative to the origin root (no
    leading `/`).

  Proven live: the new opt-in integration test
  (`src/__integration__/rust-edge-devnet.integration.test.ts`) paid for a real
  relay write through the deployed devnet Rust connector — sealed wire, EIP-712
  TokenNetwork claim from a chain-resolved channel, relay 200, claim journaled
  durably on the box.

### Patch Changes

- 658f613: Documentation only: bring the READMEs in line with the sealed wire (#447–#452).

  - `packages/client/README.md` gains **How a paid write works (the sealed wire)** —
    ask the terminating connector for its identity (`GET /ilp/identity`), ask the route
    for its price (`GET /ilp/routes/price`), seal an OER envelope carrying a shared
    secret, mint the condition as `deriveCondition(deriveFulfillment(secret))`, send,
    and open the answer with the same secret. Records that a reject raised short of the
    termination is necessarily plaintext and therefore distinguishable from one the
    destination sealed, and lists what went away with the plaintext path.
  - `docs/api-reference.md`: `publishEvent`'s documented result was still the
    pre-sealed-wire shape (a `fulfillment` field that no longer exists, no `response` /
    `refusedBy` / `code`, no `ilpAmount` / `proxyPath` options). Adds `getRoutePrice`.
  - Both note that the HTTP client edge is now required even when packets travel over
    BTP, since identity and price are read over HTTP — the same note lands in
    `packages/client-mcp/README.md`, whose config example only ever showed `btpUrl`.
  - `packages/rig/README.md`: what a write costs is now flat per route (from the
    kind:10032 announce's `capabilities`), not per byte; `rig clone` is documented as
    the free, identity-less read it is, including that it leaves `toon.owner`,
    `toon.repoid` and the relay as `origin` preconfigured; the relay is read from the
    git remote URL (`git remote set-url origin ws://…`); and `TOON_GENESIS_PEERS` is
    documented as load-bearing when pointing rig at anything other than the devnet.
  - `src/wire/vectors/README.md`: sharpens when `vectors:refresh` is the right move and
    what the drift job actually covers.

- d40ef79: Two wallet-balance reader fixes.

  **Mina settlement USDC is 6-decimal, not native MINA's 9.** `readMinaTokenBalance`
  reported the custom settlement-token balance at `assetScale` 9 — nanomina's scale —
  so a 50 USDC balance (`50_000000`) misdisplayed as `0.05`. TOON's settlement USDC is
  6-decimal on every chain; the Mina custom-token amount is a raw u64, so it is now
  scaled at 6 to match EVM and Solana. Native MINA is untouched and still reads at 9.

  **Bound each wallet-balance request independently.** The multi-chain read wraps all
  three chains in one `Promise.all` under a single outer bound, and the individual
  reads had no per-request timeout — Node's global `fetch` (Solana/Mina) has none by
  default — so one stalled socket hung the whole read and surfaced as "wallet balances
  unavailable" with _no_ chains at all. Each request is now bounded on its own (viem's
  `timeout` + `retryCount` for EVM, an `AbortSignal` for the Solana/Mina `fetch`), so a
  slow endpoint degrades only its own chain to `unreadable` and the others still
  render. Env override `TOON_WALLET_RPC_TIMEOUT_MS` (default 8000; `0` disables).

## 0.22.0

### Minor Changes

- 4656411: Ask the terminating connector for its identity and its terms (toon-client#447).

  Adds `ConnectorEdgeClient` — `GET /ilp/identity` (the uncompressed secp256k1 key
  a packet's payload must be sealed to, per ADR 0018) and
  `GET /ilp/routes/price?destination=` (client-edge-spec §1.7), with per-endpoint
  identity caching and a distinguishable refusal for every malformed answer. A
  `404` from the price endpoint answers `null` (no locally-terminated route)
  rather than throwing, so it is never confused with a transport failure.

  Also fixes `parseX402Body` against the terms the shipped connector actually
  emits: the ILP address, endpoint and price live under `extra`, and
  `httpEndpoint` is relative (`"/ilp"`) and is now resolved against the URL that
  answered `402`. Both are additive — no existing export changes signature.

- 1d2ca72: Fold `Http402Client` onto the one envelope (#451).

  `packages/client` carried two independent HTTP/1.1 codecs. #450 deleted the
  first (`store-envelope.ts` / `fulfill-http.ts`); this removes the second, so
  the package now has exactly one encoder and no HTTP text is serialised or
  parsed anywhere in it.

  `Http402Client`'s paid path (`payOverToon`) now fetches the terminating
  connector's identity from the endpoint the 402 named, builds an OER
  `EnvelopeRequest`, seals it under a condition derived from the sealed secret,
  and opens the answer with `readExchangeOutcome` — the same `sealExchange` /
  `readExchangeOutcome` pair `publishEvent` uses. Previously it sent a
  zero-condition packet, which the Rust connector refuses outright.

  **Breaking:** `serializeHttpRequest` and `parseHttpResponse` are removed from
  `@toon-protocol/client`'s published surface. Neither is imported by
  `packages/rig`, `packages/client-mcp`, or the standalone `toon-protocol/rig`.

  Two deliberate behaviour changes on the paid path:

  - **`Host` and `Content-Length` are no longer synthesised.** The connector
    strips both by name and lets its HTTP client recompute them
    (`connector-runtime/src/app_client.rs`), and the envelope already carries the
    body length as an OER length determinant. A caller that sets either
    explicitly still has it carried verbatim.
  - **`Response.statusText` is empty.** An `EnvelopeResponse` status is two bytes
    with no reason phrase, so there is no `Created` to report; the status is the
    fact to read.

  A malformed answer now fails as `SealedResponseError`, the same way it does
  everywhere else in the package, resolving the two codecs' divergent failure
  modes (`ConnectorError` on a bad status line here versus `{isHttp:false}`
  there).

  The unpaid path is unchanged: a non-402 passes through, and a 402 with no
  `toon-channel` entry or no claim resolver is returned to the caller as-is.

- 6006645: `publishEvent` now speaks the sealed wire (toon-client#450). **Breaking.**

  A paid write is no longer a latin1 HTTP/1.1 request in `Prepare.data`. It is a
  gift wrap addressed to the connector that TERMINATES the destination, around an
  OER `EnvelopeRequest` (ADR 0018) — so `publishEvent` fetches that connector's
  identity from its own client edge (`GET /ilp/identity`) before a packet can be
  formed at all, and refuses to form one without it rather than falling back to
  any default.

  **The condition is now real.** Every publish previously sent an ALL-ZERO
  execution condition — `publishEvent` passed none and both transports
  zero-filled — which the Rust connector refuses outright (`condition_is_present`
  in `connector-domain`). It now mints `sha256(deriveFulfillment(sharedSecret))`
  from the secret it sealed (ADR 0019): derived, never random, never caller
  supplied, and verified against the returned preimage by the transport. This is
  what makes the publish path work against that connector at all.

  **The answer is opened, not re-parsed.** A FULFILL's `data` is a sealed
  response envelope, opened with the same secret and returned whole as
  `PublishEventResult.response` — status, headers and body. A non-2xx status
  rides home on a FULFILL and value moved (ADR 0020), so `response` is populated
  either way. A reject sealed at the termination is reported as the DESTINATION
  refusing (`refusedBy: 'destination'`, provable — only the termination holds the
  secret); a plaintext one as a PATH refusal (`refusedBy: 'path'`).

  ### Removed from the published surface
  - `buildStoreWriteEnvelope`, `parseFulfillHttp`, `parseFulfillHttpBytes` and
    `ParsedFulfillHttp` — `utils/store-envelope.ts` and `utils/fulfill-http.ts`
    are deleted. There is no HTTP text on this wire to parse.
  - `ILP_CLAIM_WRAPPED_HEADER` — a declared NIP-59 hook never set or read
    anywhere.
  - `PublishEventResult.data` (raw base64 FULFILL bytes) → `response`, the opened
    envelope. `extractArweaveTxId` takes that envelope rather than a base64
    string.

  ### Added
  - `sealExchange` / `readExchangeOutcome` (`src/wire/sealed-exchange.ts`): the
    seal, the condition and the reader for the answer, produced together so they
    cannot drift apart, plus `envelopeHeader` and `SealedResponseError`.

  ### Downstream

  `packages/rig` and `packages/client-mcp` in this repo move with it. The
  standalone `toon-protocol/rig` repo pins the published `^0.21.1` and needs its
  own release: `standalone-publisher.ts` imports `parseFulfillHttp` and keeps a
  duplicated `extractArweaveTxId` — both go, since the client's extractor is
  exported (the comment claiming otherwise is stale).

  The ILP layer is unchanged: same `POST /ilp`, same OER PREPARE/FULFILL/REJECT,
  same `ILP-Payment-Channel-Claim` header, same channel and watermark machinery.
  Only `data` and the condition changed.

- 29fc8d2: Stop computing a per-byte price; ask for the route's price (#452).

  ADR 0020 makes a price flat per handler: one handler, one price, and an app
  that wants to charge differently exposes more handlers. Byte-proportional
  pricing has no successor — the route table is the price list. A 100-byte and a
  100 KB write to the same handler now cost the same, and the connector charges
  accordingly regardless of what a client computes.

  Four independent `10n` rates existed, each with a comment asserting it matched
  the others. All four are gone, not centralised:

  - `ToonClient.publishEvent`'s `basePricePerByte`, along with the TOON encoding
    produced only to be measured.
  - `modes/http.ts`'s `basePricePerByte` bootstrap option.
  - `client-runner.ts`'s `UPLOAD_FEE_PER_BYTE`.
  - `StandalonePublisher`'s `uploadFeePerByte`.

  A packet's amount now comes from `GET /ilp/routes/price?destination=` at the
  terminating connector — the same longest-prefix lookup the claim gate charges
  against, so it can never state a price a real request would not be charged.
  Prices are cached per (endpoint, destination) by `ConnectorEdgeClient`, so this
  is one round trip per destination rather than one per packet.

  **Breaking — `@toon-protocol/client`**

  - `publishEvent` fetches a price when `options.ilpAmount` is omitted. An
    explicit `ilpAmount` still overrides and skips the lookup entirely.
  - A destination the connector terminates no route for now raises
    `NO_TERMINATED_ROUTE` before any packet is formed, rather than being priced
    at zero or at a local fallback.
  - New: `ToonClient.getRoutePrice(destination)`, and
    `ConnectorEdgeClient.invalidateRoutePrice` / `hasCachedRoutePrice`.

  **Breaking — `@toon-protocol/rig`**

  - `FeeRates.uploadFeePerByte` and `FeeRates.minUploadFee` are replaced by a
    single flat `FeeRates.uploadFee`. With a flat price there is no floor to
    apply, because the route's price is the whole fee rather than a lower bound
    on one.
  - `flooredUploadFee` is removed from the published surface.
  - `StandalonePublisher`'s `uploadFeePerByte` constructor option is removed;
    `routePrices.store` is the upload fee. With no announced store price the
    publisher quotes 0 and lets the connector refuse, rather than inventing a
    rate.

  The standalone `toon-protocol/rig` repository carries its own copy of
  `standalone-publisher.ts` and pins the published client, so it needs the same
  removal and its own release.

  Note: `@toon-protocol/core`'s `BootstrapService` retains an internal
  `basePricePerByte` default for its own bootstrap/discovery pricing surface.
  That is a separate package and a separate concern; nothing in this repository
  states a per-byte rate any more.

- af19e7a: A structured OER envelope codec, replaying the committed cross-repo vectors
  (toon-client#448).

  Adds `src/wire/` — canonical OER length primitives and the request/response
  envelope codec, a faithful port of `connector_domain::envelope`. Header order
  and duplicate header names survive a round trip; non-canonical, zero-length-alias
  and over-wide length determinants are each refused with their own reason (ADR
  0023); arbitrary bytes never throw anything but an `EnvelopeError`.

  The connector's `vectors/wire-vectors.json` is vendored under
  `src/wire/vectors/` with its provenance and a SHA-256 integrity check, refreshed
  by `pnpm --filter @toon-protocol/client vectors:refresh` and watched for drift
  daily by `.github/workflows/wire-vectors-drift.yml`.

  Additive: the existing `utils/store-envelope.ts` / `utils/fulfill-http.ts` HTTP
  framing is untouched and still what the send path uses.

- e38677d: The gift wrap and the fulfilment a shared secret derives (toon-client#449).

  Adds `src/wire/giftwrap.ts` — a faithful port of `connector_signer::giftwrap`:
  `sealRequest`/`openRequest` (ECDH to the terminating connector's identity key
  over the raw X-coordinate, `0x01 ‖ ephemeral_public(65) ‖ nonce(12) ‖
ciphertext` around `shared_secret ‖ encoded_envelope`),
  `sealResponse`/`openResponse` (`0x02 ‖ nonce ‖ ciphertext`, sealed with the
  request's own secret — no second key exchange), `looksLikeSealedResponse`,
  `deriveFulfillment` (HKDF-SHA256, no salt, info `toon-giftwrap-fulfillment`)
  and `deriveCondition` (`sha256`). AEAD is ChaCha20-Poly1305.

  The vendored vector file's `giftwrap` and `fulfilment` sections are now
  replayed: every pinned `request_wrap_hex`, `response_wrap_hex`, fulfilment and
  condition is reproduced byte-for-byte, so all four sections the connector
  publishes are replayed and none is carried unreplayed.

  Failure modes stay separable by type: a wrap that cannot be opened is a
  `GiftWrapError`; a wrap that opens cleanly but decodes to a malformed envelope
  is an `EnvelopeError`.

  New dependency: `@noble/ciphers` (ChaCha20-Poly1305). `@noble/curves` and
  `@noble/hashes` already covered secp256k1 and HKDF-SHA256.

  Additive: nothing in the send path calls this yet — `publishEvent` still uses
  the latin1 HTTP framing in `utils/store-envelope.ts`.

### Patch Changes

- 7b8176a: Refresh the vendored cross-repo wire vectors to connector `main` (#588), and
  replay the new `claim` section against `signing/evm-signer.ts`.

  The drift check added in toon-client#454 fired for the first time: connector#588
  added a `claim` section to `vectors/wire-vectors.json`. The vendored copy and its
  provenance now pin connector `425a8abb72e982f43955c35d9c0cf50fd5a2d55e`.

  `claim` is the EIP-712 `BalanceProof` of connector ADR 0024 — the same struct and
  the same per-channel `TokenNetwork` domain that `EvmSigner.signBalanceProof`
  already signs on the client edge — so it is replayed, not carried unreplayed:
  this client reproduces the published digest and the published 65-byte signature
  byte-for-byte.

  The harness can no longer ignore a section it does not understand. `load.ts`
  exports a closed `WIRE_VECTOR_SECTIONS` list, and the suite fails if the vendored
  file carries a section outside it, or one that is neither declared replayed nor
  declared deliberately-not-yet-replayed.

  Test-only: nothing under `src/wire/vectors/` is reachable from `src/index.ts`, so
  the published surface is unchanged.

## 0.21.3

### Patch Changes

- ba1a585: Fix `packages/client` typecheck debt (#431): `BTPErrorData` now has a `message`
  field (the trailing wire `data` octet string decoded as UTF-8) and the
  `triggeredBy` property-name typo in `IsomorphicBtpClient` is corrected to the
  real wire field `triggeredAt`. `KeyVault`'s `fromBase64`/`deriveKekFromPassword`
  now use `Uint8Array<ArrayBuffer>` so they satisfy `BufferSource` under
  TS 5.9's stricter lib-DOM typing (no runtime behavior change).

## 0.21.2

### Patch Changes

- b764b92: fix(rig): `rig balance` shows all three chains (EVM / Solana / Mina)

  `rig balance` previously showed only the EVM chain: the rig-embedded client
  builds its config via `resolveNetworkTopology` (not `applyNetworkPresets`), so a
  single-EVM-chain identity had no `solanaChannel`/`minaChannel`, and
  `getWalletBalances` gated the Solana/Mina rows on those being set.

  The wallet view now falls back to the named network's public RPC/GraphQL
  (`resolveClientNetwork`) when no channel is configured, so all three chains
  appear — the address is derived from the mnemonic and the balance reads `0` for
  an account not yet on-chain. `getWalletBalances(fallback)` gains an optional
  wallet-view-only fallback; it is threaded through the rig money seam and is
  NEVER merged into settlement config, so chain negotiation is unaffected. Explicit
  `config.solanaChannel`/`minaChannel` still win.

## 0.21.1

### Patch Changes

- f03aaef: Fix three related Mina-settlement bugs in `rig push` (standalone mode) that
  made a first-time, unfunded, or interrupted Mina channel-open fail slowly and
  wastefully:

  - **Fee-payer preflight (fail fast).** Before compiling the `PaymentChannel`
    circuit (1–3 min) or attempting a zkApp deploy, the fee payer's on-chain
    MINA balance is checked. An account that does not exist / is under
    ~1 MINA (account-creation fee + tx fees) now throws
    `MinaFeePayerUnfundedError` naming the address, the required amount and the
    network — in seconds, before any compile. Previously the circuit compiled
    first and only then did `Mina.transaction` throw
    `getAccount: Could not find account for public key …`.

  - **o1js transaction-nesting on retry.** `Mina.transaction` enters o1js's
    module-level `currentTransaction` context and then reads the fee-payer nonce
    (`getAccount(sender)`) OUTSIDE the try/finally that would leave it, so an
    unfunded fee payer leaked the context. The next `Mina.transaction` (the
    cache-invalidation retry) then threw `Cannot start new transaction within
another transaction`. Every Mina tx now builds through `buildMinaTransaction`,
    which abandons any leaked context on failure so a retry starts clean; the
    preflight error is also treated as non-recoverable so it does not trigger a
    pointless topology re-resolution.

  - **Orphaned zkApp deploys.** The dedicated per-pair zkApp key is now persisted
    BEFORE the deploy tx is sent (`onDeploying`), and a recorded-but-unconfirmed
    deployment is REDEPLOYED at the SAME address on the next run instead of
    minting a brand-new zkApp — so a crash or retry between deploy and
    confirmation no longer burns the ~1.1-MINA account-creation fee on a fresh
    zkApp each attempt.

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
