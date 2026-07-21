# @toon-protocol/rig

## 2.13.3

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

- Updated dependencies [b764b92]
  - @toon-protocol/client@0.21.2

## 2.13.2

### Patch Changes

- 8eea197: `rig balance` never exits silently on the Mina settlement path. The wallet read
  (`money.walletChainBalances()`) was awaited unbounded, so a Mina read that
  neither resolved nor kept a live handle open let Node's event loop drain and the
  one-shot CLI exit `0` with no output at all — only the earlier settlement-chain
  alignment warnings on stderr. The read is now time-bounded
  (`RIG_BALANCE_WALLET_TIMEOUT_MS`, default 20s; `0` opts out): its live timer
  prevents the drain and forces a decision. On a hang or a rejected read, balance
  prints the identity + recorded channels plus a loud, actionable wallet notice
  and exits non-zero (a single error envelope under `--json`) — the report and
  channels are still shown, never a silent success.
- 2b20e28: `rig balance`: flag channels whose cumulative claims exceed the recorded
  on-chain deposit as OVERDRAWN. `available` is
  `max(0, deposited − claimed)`, so an overdrawn channel showed `available 0`
  with no indication that the signed claims had run past the collateral (e.g.
  `deposited 100000 claimed 140840 available 0`). The on-chain TokenNetwork
  caps redemption at the deposit, so the excess is unsecured — the balance
  view now surfaces the overdraft amount and suggests a top-up. Adds an
  `overdrawn` field to the `--json` envelope.
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

- Updated dependencies [f03aaef]
  - @toon-protocol/client@0.21.1

## 2.13.1

### Patch Changes

- 2419321: Split the printed Rig-page/site URL gateway (now `ar-io.dev`, where the ar.io
  testnet store uploads are actually served) from the rig-web bundle asset
  gateway (`arweave.net`, which honors the bundle's `Content-Encoding: gzip`
  tag — `ar-io.dev` drops it and the browser gets raw gzip). New
  `DEFAULT_RIG_WEB_GATEWAY` / `RIG_WEB_GATEWAY` env control the bundle gateway;
  `RIG_ARWEAVE_GATEWAY` keeps controlling printed URLs, with the other gateway
  printed as an "also:" mirror line.

## 2.13.0

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

### Patch Changes

- Updated dependencies [1307ee9]
  - @toon-protocol/client@0.21.0

## 2.12.0

### Minor Changes

- 261ac8e: Auto-derive the Mina payment channel and per-chain RPC URLs from the peer
  announce, so a fresh devnet client no longer needs to hand-write a `minaChannel`
  block or a `chainRpcUrls` override in `~/.toon-client/config.json`.

  Previously EVM and Solana settlement derived from the announce + core presets,
  but Mina was the only chain that required explicit config, and RPC endpoints
  came solely from the baked core presets — where the EVM default
  (`sepolia.base.org`) is a stale-read load balancer that breaks
  `openChannel`→`setTotalDeposit`, so a first-time client was effectively broken
  on EVM channel-open until it manually overrode the RPC.

  Now the client consumes two additive announce content fields — `minaTokenIds`
  and `chainRpcUrls` — with precedence **explicit config > announce > core
  preset**:

  - `minaChannel` is derived when absent (zkAppAddress from the announced
    `tokenNetworks`, tokenId from the new `minaTokenIds`, graphqlUrl/networkId
    from the preset); an explicit `config.minaChannel` still wins verbatim.
  - EVM/Solana/Mina RPC URLs resolve from the announce first, so the live
    deployment advertises working endpoints (e.g. the correct Base Sepolia RPC)
    instead of the client falling back to a stale/broken baked preset.

  Announce-advertised **first**, with the core preset as a drift-proof fallback:
  the deployment-specific values (zkApp, tokenId, RPC) are drift-prone, so the live
  announce overrides when present. The corrected core preset (Mina zkApp + tokenId,
  publicnode Base Sepolia RPC) is the baked fallback a fresh client resolves when
  the announce carries nothing — so once this client picks up the corrected core
  release, a fresh `rig fund && rig balance` works on all three chains **without**
  waiting on a connector redeploy. Fully backward-compatible: old clients ignore
  the new announce fields; the announce still wins over the preset when present.

### Patch Changes

- Updated dependencies [261ac8e]
  - @toon-protocol/client@0.20.3

## 2.11.0

### Minor Changes

- 44003b7: Add `rig chain` — choose which chain (and therefore which USDC token) settles
  paid `rig` writes. Each supported chain has its own USDC (EVM/Base Sepolia,
  Solana devnet, Mina devnet), and settlement selection was previously only
  possible via the `TOON_CLIENT_CHAIN` env var or hand-editing
  `~/.toon-client/config.json`. The new command persists the choice to the config
  `chain` field (a read-merge-write that preserves every other field):

  - `rig chain` — show the current settlement-chain preference and which USDC it
    spends (or that selection is automatic when unset).
  - `rig chain set <evm|sol|mina>` — pin the chain/USDC (`sol`/`eth` aliases and a
    full id like `evm:base:84532` are accepted).
  - `rig chain unset` — clear the pin, reverting to automatic selection.

  Free (local config only; never touches the relay or a chain). Warns when
  `TOON_CLIENT_CHAIN` or a `supportedChains` array would take precedence over the
  written value, and `--json` emits a machine-readable envelope.

## 2.10.3

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

- 42c5f12: Fix `rig site publish` emitting a manifest `index` pointing at a path that isn't in the site's files (e.g. no `index.html`), which made the site root 404 in a way indistinguishable from ArNS propagation lag. The manifest builder now omits `index` when the path is absent; `rig site publish` already warned and supported `--index <path>`.
- 8aab2ed: Add `rig name set --tx-id <id>` as an explicit alternative to the positional `<txId>`, so an Arweave txId that leads with `-` or `_` (both valid in base64url) is never misread as an unknown flag by the arg parser.
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

- Updated dependencies [cdd7a0c]
- Updated dependencies [9751296]
  - @toon-protocol/client@0.20.2

## 2.10.2

### Patch Changes

- af4cdb7: Floor every rig-standalone per-packet claim at the destination route's announced price. The devnet connector (>= 3.34.6) gates every paid packet at the FLAT route price carried in the apex kind:10032 announce's `capabilities` (`os.publish` -> `g.proxy.relay`, `os.store` -> `g.proxy.store`, price `1000`): a balance-proof claim advancing the channel by less is rejected (`F06 - Insufficient claim value`), which broke small `rig push` uploads (74 bytes x 10/byte = 740 < 1000) and `feePerEvent: "0"` publishes. rig now parses the announced capability prices, threads them into the StandalonePublisher as per-destination floors, and claims `max(computed fee, route price)` for uploads AND event publishes; per-byte pricing above the floor is unchanged, and peers announcing no prices keep the exact pre-floor behavior. `getFeeRates` folds the floors in (`eventFee` pre-floored, new optional `FeeRates.minUploadFee`), so the `rig push` confirm table, the rig-page pointer fee, and `rig site` estimates all equal what is actually claimed. Also fixes explicit settlement-chain pinning: `TOON_CLIENT_CHAIN` (or the `chain` config field) set to a full EVM chain id in a different spelling than the announce (`evm:base:84532` vs announced `evm:84532`) is now aligned to the announced spelling instead of being silently stranded by the exact-string chain negotiation.

## 2.10.1

### Patch Changes

- 9fc0428: Stop resolving the retired self-hosted devnet chain RPCs in rig standalone. The TOON devnet's self-hosted chain boxes (`evm-rpc.devnet.toonprotocol.dev`, `solana-rpc.devnet.toonprotocol.dev`) are retired (2026-07-19); the devnet now settles on public networks (Base Sepolia `evm:84532`, public `solana:devnet`, `mina:devnet`). The devnet-zone RPC table and the `zoneSelfHosted` guard — which suppressed the public `solana:devnet` core preset for announces under `*.devnet.toonprotocol.dev` — are removed, so core public presets apply everywhere. Precedence is unchanged: explicit config > announce > core preset.

## 2.10.0

### Minor Changes

- f14819e: `rig name buy --via <store-url>` — brokered ArNS purchase through the store's kind:5095 job: spawns a client-owned ANT and submits the buy with its processId, so the store pays mARIO while the client owns the name from inception (toon-meta#162).
- 6e94527: Fix the two #384 devnet e2e findings:

  - **Zero-config chain negotiation**: the shipped devnet RPC endpoint table now
    matches EVM chains by numeric chain id, so an announce spelling the devnet
    chain `evm:anvil:31337` (the qualified `evm:{network}:{chainId}` key format)
    resolves the same zone RPC as `evm:31337`. A bare mnemonic + relay URL can
    balance-probe the announced EVM chain again instead of skipping it and
    falling through to an unusable `solana:devnet` pick that died at push time.
  - **Identity precedence**: an env- or `.env`-sourced `RIG_MNEMONIC` now derives
    at account 0 regardless of the active `TOON_CLIENT_HOME` — a per-home
    config's `mnemonicAccountIndex` applies only when the phrase itself came
    from that shared state dir. The new `RIG_ACCOUNT_INDEX` environment variable
    overrides the account index for every source (malformed values fail fast).

### Patch Changes

- 9d35d3a: Fix `rig name` against every published `@ar.io/sdk` (#376): the verbs guarded on a `SolanaSigner` export that no released SDK ships, so they always died with `arns_sdk_unavailable`. The default loader now drives the Solana-native SDK the way 4.0.3 actually works — an explicit `@solana/kit` `createSolanaRpc` transport (the SDK builds no defaults), plus `createKeyPairSignerFromBytes` over the identity's 64-byte Ed25519 key and an `rpcSubscriptions` client for writes only. `rig name status` (and all free reads) now runs signerless; "SDK not installed" (`arns_sdk_unavailable`) is distinguished from "SDK installed but API-incompatible" (`arns_sdk_incompatible`, minimum `@ar.io/sdk` 4.0.3 stated and pinned in optionalDependencies); and an env-gated live smoke test (`pnpm test:arns-live`) executes real free reads against the published SDK so the surface can never silently drift again.
- 26698d6: README: document the ar.io network program ids for `rig name` (`--network` mainnet/devnet table, MPL Core id, no-testnet note, free devnet loop).

## 2.9.0

### Minor Changes

- ee90dcf: rig push: every push keeps the repo's Rig page current — a permanent per-repo Arweave pointer that RENDERS the repo in place, the repo's GitHub-Pages equivalent served entirely from Arweave + the relay.

  - The pointer boots the FULL React Rig from its Arweave deployment: `window.__RIG_CONFIG__` pins relay/owner/repo, the HashRouter route is preset in the pointer's own fragment, and rig-web's entry css/js load from an ar.io path manifest — module-relative imports resolve against the module URL, so the whole chunk graph serves from Arweave while the address bar stays on the pointer. The deployment itself (`rig-web/scripts/deploy-arweave.mjs`) fits ArDrive Turbo's FREE tier: shiki now uses its JS regex engine (no 600 KiB wasm), vite splits vendors per package so every output gzips < 100 KiB, and each file uploads gzipped with a `Content-Encoding` tag that ar.io gateways serve as a header (verified live) — 122 files + manifest, $0, no funded wallet. `RIG_WEB_TX`/`RIG_WEB_ENTRY_JS`/`RIG_WEB_ENTRY_CSS` override the bundle. The single-file rig-lite build stays in-tree as the ultra-light option.
  - Content-addressed: the pointer HTML is deterministic for (rig-web URL, relay, owner, repoId) and recorded locally (`rig-pointers.json`), so it is paid for once and reused free until an input changes. Its fee is part of the confirmed push total; `--no-rig-page` skips it; a pointer failure never fails a succeeded push (the next push retries). Printed as `Rig page: <ar.io-gateway>/<txId>`; the `--json` envelope carries a `rigPage` report. Daemon-path pushes skip with a note (no raw-blob route yet).
  - Test-harness hardening: the strict-json `run()` helper now defaults to a hermetic `TOON_CLIENT_HOME` — an empty env let command tests write local record stores into the developer's real `~/.toon-client`.

## 2.8.0

### Minor Changes

- 51ae5dc: rig standalone: Solana funded-chain probe in settlement-chain selection.

  - Rule 3 ("funded") of `selectSettlementChain` now probes announced `solana:*` chains alongside `evm:*` chains, in ANNOUNCE ORDER across both families — a wallet funded only on Solana automatically settles there instead of defaulting to an unfunded EVM chain. The first chain with a balance > 0 wins; when both families are funded, the peer's announce order breaks the tie. Probe errors and candidates whose RPC/token are underivable skip the chain, exactly as before. Rule 4 (default = first announced EVM chain) is unchanged.
  - New `solanaTokenBalance` probe: one raw JSON-RPC `getTokenAccountsByOwner` POST (`{mint}` filter, `jsonParsed` encoding, amounts summed across the owner's token accounts, 5s timeout, injectable fetch) — same zero-heavy-deps style as `evmTokenBalance`; @solana/web3.js stays out of the pre-client-start path.
  - The probed owner is the identity's own base58 Solana address, derived pre-client-start via `@toon-protocol/client`'s `deriveFullIdentity` (SLIP-0010 `m/44'/501'/{account}'/0'` — the same paths the embedded client settles with). Derivation only runs when a `solana:*` chain is actually announced and no explicit chain pins selection; when the Ed25519 derivation is unavailable, Solana chains are simply not probed.
  - `SelectChainOptions` gains `solanaAddress?` and `probeSolanaBalance?` (injectable, mirroring `evmAddress`/`probeBalance`); `NetworkTopologyInputs` gains the matching `probeSolanaBalance?` test override.

- 4b9396a: rig standalone: Solana + mainnet settlement support in the embedded-client paid path.

  - Solana channel parameters (`rpcUrl`/`programId`/`tokenMint`) are now derived per chain with the same `explicit config > kind:10032 announce > preset` precedence EVM already gets, and fed to the embedded client as `solanaChannel`. The announce's chain-keyed `tokenNetworks` map carries the payment-channel program id and `preferredTokens` the SPL mint. Core's client network presets cover the public clusters (deployed public-devnet program; mainnet-beta RPC + Circle USDC once the program is announced/configured). A Solana chain in play whose parameters are underivable fails fast with an actionable `SolanaChannelUnderivableError` (selected chain) or is dropped from the advertised list with a warning (listed chain) — never the embedded client's late "Solana channel config not provided".
  - EVM mainnet chains (`evm:base:8453`, `evm:42161`, …) resolve RPC + Circle USDC from core presets by numeric chain id; the TokenNetwork comes from the announce or explicit config (fail-fast otherwise), locked by tests.
  - A configured EVM chain spelling that names the same numeric chain id as an announced chain (config `evm:base:31337` vs announced `evm:31337`) is now aligned to the announced spelling before negotiation — chain negotiation matches identifiers exactly, so the mismatch previously stranded the EVM chain and negotiation silently fell through to an unopenable chain. Chain-keyed maps are re-keyed and pruned to the advertised list (the client validates `chainRpcUrls` keys ⊆ `supportedChains`).
  - Announce discovery is no longer skipped for "fully explicit" configs whose listed `solana:*` chain lacks explicit channel parameters — the announce is a needed parameter source. Devnet-zone self-hosted chains (announce zone or a `*.devnet.toonprotocol.dev` RPC host) never take public-cluster preset addresses (the zone's Solana program id is regenerated per redeploy).

  Verified live against the deployed devnet: a first `rig push` from a fresh identity now aligns `evm:base:31337` → `evm:31337`, negotiates EVM, opens the channel on-chain, and publishes (previously died with "Solana channel config not provided").

## 2.7.2

### Patch Changes

- Updated dependencies [fb7485d]
  - @toon-protocol/client@0.20.0

## 2.7.1

### Patch Changes

- 640f527: docs(rig): document the `rig site` (permaweb sites) and `rig name` (ArNS) verbs in the package README — the push → publish → name → permanent URL flow, plus command-reference rows and the funds/`@ar.io/sdk`/mARIO-not-ILP caveats.

## 2.7.0

### Minor Changes

- 20fc778: rig: ArNS naming verbs + pushed repos as permaweb sites.

  - `rig name buy/set/status` (#367): ArNS naming verbs owned and paid by the rig mnemonic's Solana key (no new key material). estimate→confirm→execute + strict `--json` + `--yes`; `@ar.io/sdk` is an optional, lazily-imported dependency; `status` is a free registry read. Fee output states payment is mARIO on Solana via the ar.io registry, not ILP.
  - `rig site publish` / `rig site url` (#368): build and serve an ar.io path manifest per ref so a pushed repo doubles as a permaweb site, with `--spa`/`--fallback`/`--gateway`/`--force-reupload`. Per-file `Content-Type` is now derived from the blob path on kind:5094 blob uploads (previously hardcoded to `application/octet-stream`).

  All money-moving paths are estimate→confirm→execute and were mock-tested only — no funds spent by this release.

## 2.6.4

### Patch Changes

- Updated dependencies [c3b34b0]
- Updated dependencies [0eaa65e]
- Updated dependencies [c816641]
  - @toon-protocol/client@0.19.0

## 2.6.3

### Patch Changes

- Updated dependencies [2eb9709]
  - @toon-protocol/client@0.18.0

## 2.6.2

### Patch Changes

- Updated dependencies [a6caf80]
- Updated dependencies [488cdbf]
  - @toon-protocol/client@0.17.0

## 2.6.1

### Patch Changes

- a810591: docs(rig): rewrite the README as a start-to-finish "code → published repo" guide — a linear 8-step walkthrough (identity → init → relay → fund → commit → push → verify) with the funding step included, plus a consolidated command reference and money/channel section. Reference material (identity, passthrough, pushing, cloning, library) retained below the guide.

## 2.6.0

### Minor Changes

- 245c9ab: rig: capability-check the daemon before delegating git ops; actionable error against an old toon-clientd (#306)

  `rig push` (and `issue`/`comment`/`pr create`/`pr status`) against a running-but-OLD `toon-clientd` used to dead-end with an opaque `daemon rejected the operation (HTTP 404): Not Found`. The daemon-as-accelerator delegation (#279) probes `GET /status` and, on a same-identity match, delegates to the daemon's `/git/*` routes — but those routes only exist since #227, so an older daemon has `/status` yet 404s every git call.

  - **client-mcp**: `/status` now advertises `capabilities: ['git']` so a version-skewed rig can gate before it commits to a route the daemon lacks. Backward-compatible additive field; the daemon must be restarted to advertise it. (Fixed-group with `@toon-protocol/views`.)
  - **rig**: capability-probes the daemon before delegating. A same-identity daemon that does not advertise `git` (or predates the field) no longer dead-ends — it raises a clear, actionable error naming both remediations (upgrade `@toon-protocol/client-mcp@latest` + restart, or stop the daemon to run standalone). A `/git/*` 404 despite a positive probe degrades to the same message (defense in depth). No silent fallback to standalone: a same-identity daemon makes the #228 nonce guard refuse standalone anyway, so the only correct resolution is upgrading or stopping the daemon.

- ff5f576: `rig fund` funds ALL supported chains by default (#309). A plain `rig fund` now
  drips to evm + solana + mina in one run — each drip covering the native coin AND
  USDC — so the wallet matches the multi-chain `rig balance` view (#299) instead
  of requiring three separate `--chain` runs.

  - **Multi-chain by default.** No `--chain` funds every supported chain;
    `--chain <one>` still narrows to a single chain (preserved); `--chain all` is
    the explicit alias for the default. The env/config `chain` settlement
    preference no longer narrows `rig fund` (funding all chains is a superset).
  - **Parallel, independent drips.** The Mina faucet legitimately takes ~75s, so
    the per-chain drips run concurrently (overlapping their timeouts) rather than
    stacking to ~150s. Each chain's result is independent: one chain's faucet
    failing never aborts the others.
  - **Exit code:** `0` only when every targeted chain funded; `1` if any chain
    failed — the per-chain breakdown is always shown (`evm ✓ funded (ETH +
USDC)` / `solana ✗ <reason>`).
  - **`--json`:** a per-chain `results` array (`{ chain, funded, address, error?,
response? }`) replacing the single-chain `chain`/`address`/`response` fields;
    still a strict single JSON document.
  - `--address` now requires an explicit single `--chain` (one address cannot
    fund every chain). The no-faucet path (prints all three wallet addresses) and
    the #288 devnet-origin auto-detect are unchanged.

### Patch Changes

- a8c5855: Handle empty (zero-byte) git blobs. `rig push` previously failed on any repo
  containing an empty file because it uploaded the zero-byte blob body as a
  kind:5094 request with an empty `i` value, which the store rejects as malformed
  (F00). The git empty blob (`e69de29b…`, the only zero-byte object git can
  produce) is now skipped on push — its commit/tree still references it — and
  synthesized locally on clone/fetch, so a repo with an empty file pushes and
  clones back bit-identically (git fsck clean). Fee estimates and receipts report
  the skip honestly. Closes #310.
- df6feb5: `rig fund`: echo the funded (or attempted) wallet address on each per-chain line
  of the human (non-`--json`) output — `evm ✓ funded (ETH + USDC) → 0x…` /
  `solana ✗ → <address> — <error>`. The multi-chain rewrite (#309) had dropped the
  address from the terminal output, leaving no confirmation of WHERE funds went;
  this restores it, which matters most when `--address` targets an arbitrary,
  non-derived address a typo could misdirect.
- 543ff2c: fix(rig): `rig init --git-init` now creates `main` deterministically (was
  `master` on a stock git without `init.defaultBranch=main`), matching every rig
  doc/quickstart; and `rig push`'s error when a refspec matches no local branch
  now names the missing ref and your current branch (`no local branch or tag
"main" — your current branch is "master" (did you mean \`rig push origin
  master\`?)`) instead of the misleading "ref deletion is out of scope" clause,
which is now reserved for actual `:ref` deletion syntax.

## 2.5.0

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

- 32aee92: feat(rig): `rig init` sets the git commit-author from the nostr identity

  `rig commit` is a git passthrough, so on a repo where the user never set a
  global git identity it dead-ended on git's "Author identity unknown / empty
  ident name not allowed". `rig init` now sets this repo's LOCAL git author
  (never `--global`) from the resolved nostr identity, so `rig commit` /
  `git commit` work out of the box and every commit is attributed to the signer
  — commit author == push signer == nostr identity, a coherent authorship chain
  baked into the git objects on Arweave.

  - `user.email` = `<npub>@nostr` (npub is a valid email local part).
  - `user.name` = the identity's kind:0 profile display name when published
    (prefer `display_name`, else `name`, read latest-wins from a resolvable
    relay), best-effort; falls back to the npub when there is no profile, no
    resolvable relay, or the read fails. Relay resolves at init time from
    `--relay` → `origin`/`toon.relay` → the genesis seed, with a short
    (~3s, `RIG_PROFILE_TIMEOUT_MS`-overridable) timeout — init never blocks or
    errors on the profile read.
  - Idempotent: a later `rig init` refreshes `user.name` from a now-readable
    profile. Reported in the human output and in `--json` as
    `gitAuthor: { name, email, source: 'profile' | 'npub' }`.

  Closes #302.

- 369a035: feat(rig): `rig init` initializes the git repo itself instead of dead-ending

  `rig init` already offers to mint + persist an identity on a cold start
  (#294), but it flatly refused when the cwd was not inside a git repository —
  hinting at `git init` and never running it. Creating a `.git` is a smaller,
  safer, idempotent action than minting a seed phrase, so init now offers it
  too, behind the same consent gate:

  - **TTY**: prompts `Initialize a git repository here? [y/N]` (same default-no
    shape as the identity prompt). On yes it runs `git init` in the cwd and
    proceeds with normal init; on no it keeps the existing remediation.
  - **`--git-init`**: non-interactive flag that runs `git init` then proceeds
    (the scripting path); also skips the prompt in a TTY.
  - **Non-TTY / `--json` without the flag**: still refuses (never silently
    creates a repo), but the `NotAGitRepositoryError` remediation now leads with
    `rig init --git-init` (and still mentions plain `git init`).

  `git init` runs in the resolved cwd only (never a parent). Combined with
  `--generate-identity`, `rig init --git-init --generate-identity` is a fully
  non-interactive fresh setup: an empty directory becomes rig-ready in one
  command (git repo → identity → toon config). `--json` reports the new
  `initializedGitRepo` field. Closes #300.

### Patch Changes

- Updated dependencies [bc1befc]
  - @toon-protocol/client@0.16.0

## 2.4.1

### Patch Changes

- bca9698: `rig fund`: infer devnet from a configured devnet git origin (#288).

  The shipped #291 auto-detect only inspected the env/config
  `relayUrl`/`proxyUrl`/`btpUrl` endpoints — NOT the git `origin` remote that
  `rig remote add origin <relay-url>` configures. So a fresh user who followed
  the documented flow (`rig remote add origin
wss://relay-ws.devnet.toonprotocol.dev`, then `rig fund`) still landed on
  network `custom` and had to also export `TOON_CLIENT_NETWORK=devnet`.

  `rig fund` now ALSO resolves the origin relay URL the same way `rig push`/`rig
fetch` do (via the `rig remote`/git-config `origin` resolution) and treats a
  `*.devnet.toonprotocol.dev` origin host as the devnet signal. A plain
  `rig fund` with no env var now drips for that user.

  - An **explicit** non-`custom` `TOON_CLIENT_NETWORK` (or config `network`)
    stays authoritative and is never coerced to devnet; `TOON_CLIENT_FAUCET_URL`
    / `faucetUrl` overrides keep top precedence.
  - A non-devnet or non-relay origin (e.g. an SSH GitHub clone URL) infers
    nothing; the origin resolution is best-effort and never errors a free
    command.
  - The inference is still surfaced (the "Inferred network 'devnet' from the
    configured origin …" line / `--json` `inferredDevnetFrom`).

## 2.4.0

### Minor Changes

- f9719c6: `rig identity create` — generate an identity on first run (#294).

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

## 2.3.0

### Minor Changes

- cd0ba15: `rig fund`: infer devnet from a configured devnet origin (#288).

  When the resolved network is `custom` (or unset) but a configured origin —
  `relayUrl`/`proxyUrl`/`btpUrl` or their `TOON_CLIENT_*_URL` env overrides —
  points at the shared devnet (`*.devnet.toonprotocol.dev`), `rig fund` now
  treats the network as `devnet` and drips from the deployed devnet faucet
  automatically, instead of stopping to tell the user to also export
  `TOON_CLIENT_NETWORK=devnet`. The origin host already encodes `devnet`, so the
  extra step is redundant.

  - An **explicit** non-`custom` `TOON_CLIENT_NETWORK` (or config `network`)
    stays authoritative and is never coerced to devnet; `TOON_CLIENT_FAUCET_URL`
    / `faucetUrl` overrides keep top precedence.
  - The inference is surfaced, not silent: human output prints an "Inferred
    network 'devnet' from the configured origin …" line and `--json` carries
    `inferredDevnetFrom`.
  - The #280 remediation text is unchanged for the no-devnet-origin case.

- c116ca8: fix(rig,rig-web)!: honor issue/PR status only from repo owner + declared maintainers (#287)

  Issue/PR status (kind:1630-1633) was resolved naive last-write-wins over ALL
  events regardless of signer, so any funded identity could overwrite another
  owner's issue/PR state. State resolution now honors ONLY status events signed
  by an AUTHORIZED author — the repo OWNER (always) ∪ the MAINTAINERS declared on
  the kind:30617 announcement (a new `["maintainers", <hex>, …]` tag). Unauthorized
  status events are ignored for state (a permissionless relay can still carry them,
  so this is a consumer-side filter).

  - `buildRepoAnnouncement` gains an optional maintainers list; `parseMaintainers` /
    `authorizedStatusAuthors` parse it. `RemoteState.maintainers` and the views
    `RepoMetadata.maintainers` surface it.
  - `deriveStatus` (rig CLI tracker) and `resolvePRStatus` / `resolveIssueStatus`
    (views, used by rig-web) now take an authorized-author set and filter by it.
  - New `rig maintainers list|add|remove <pubkey>` command republishes the 30617
    to manage the set (owner-only, confirm-gated).
  - `rig pr status` / `issue status` warn when the active identity is not a
    maintainer (the write still publishes — permissionless — but the futility is
    made obvious).

  BREAKING: `resolvePRStatus` / `resolveIssueStatus` require a third `authorized`
  argument; `RepoMetadata` / `RemoteState` gain a required `maintainers` field.

## 2.2.0

### Minor Changes

- dff1e0c: Kill the ~32s fixed bootstrap tax on paid rig commands (#279): daemon-as-accelerator delegation + a standalone topology cache.

  - **Daemon delegation (automatic fast path)**: when a running `toon-clientd` on the loopback control port holds the SAME identity, paid write commands (`push`, `issue`, `comment`, `pr create`, `pr status`) now delegate to its `/git/*` routes instead of refusing with `DaemonIdentityConflictError` — the daemon owns the channel watermark (one writer, the original safety goal) and its bootstrap is warm. Identity is confirmed against `GET /status` before anything is sent. A daemon on a different identity, or no daemon, runs standalone exactly as before. The chosen path prints on stderr and appears in `--json` envelopes as `"path": "daemon" | "standalone"`. `rig fund` / `rig balance` / `rig channel …` have no daemon route and stay standalone (channel mutations still refuse under a same-identity daemon).
  - **Standalone topology cache**: the resolved #264 network topology (kind:10032 announce discovery, payment-peer pick, settlement-chain selection incl. funded-chain probes) is persisted under `TOON_CLIENT_HOME` keyed by relay + identity + explicit config, TTL 15 min (`RIG_TOPOLOGY_TTL_MS` overrides; `0` disables). A cached topology that fails to bootstrap is invalidated and re-resolved live in-process. Claim watermarks and the channel map are never cached — writes still resume from the persisted cumulative.
  - **Happy-path trim**: the on-chain deposit re-read on channel resume is skipped when the channel-map record already carries `depositTotal` (accounting state only, not the claim watermark).
  - **Exit-hang fix (the actual bulk of the 32s)**: instrumentation showed the paid work completes in ~2s — the remaining ~30s was the CLI process failing to exit because the embedded client leaves a keep-alive socket holding the event loop. The `rig` bin now flushes stdio and exits as soon as dispatch resolves (all work is awaited by then). Measured on live devnet: ~32s → ~1.8s cold standalone, ~1.6s warm (cache hit), ~0.5s daemon-delegated.

- cbb631c: The rig CLI read path (#278) — the multi-player half of the forge, all FREE (relay WS reads + Arweave gateway downloads; no payments, no channel, no identity needed). `rig clone <relay-url> <owner-npub-or-hex>/<repo-id> [dir]` bootstraps a repository from TOON: fetches the kind:30617/30618 state, downloads every object the refs need from the gateway fallback chain (parallel with a concurrency cap; SHAs missing from the `arweave` map resolve through the GraphQL Git-SHA resolver), verifies EVERY body against its SHA-1 (verification doubles as type discovery — content matching no git envelope type is rejected, never written), and materializes a real repository via git plumbing (`hash-object -w --stdin -t <type>` with the written SHA re-checked, `update-ref`, HEAD symref, checked-out worktree) — atomically: everything lands in a temp dir and moves into place only on success, and gateway propagation lag (10-20 min for fresh pushes) is an honest error listing the missing SHAs. Clones are immediately push/pull-capable: toon.repoid/toon.owner, the relay as the `origin` remote, remote-tracking refs, and upstream config all land like `git clone`. `rig fetch [remote]` runs the same pipeline against an existing repo — downloads only the missing delta, updates `refs/remotes/<remote>/*` (tags to `refs/tags/*`), and reports movements `git fetch`-style (new/fast-forward/forced); no merge (`rig merge origin/main` via the git passthrough). `rig issue list|show <id>` and `rig pr list|show <id>` read the tracker from the terminal: kind:1621/1617 scoped by the repo `#a` tag, state derived from kind:1630-1633 status events (latest wins; `--state` filters), kind:1622 comments under `show`, and `pr show` prints the full `format-patch` text for `git am` piping — all tolerant of the devnet relay's non-canonical EVENT serialization, all under the strict `--json` stdout contract. `clone` and `fetch` are rig-owned verbs now (they shadow `git clone`/`git fetch` exactly like `rig push` shadows `git push`; the plain git commands stay available by calling git directly).

### Patch Changes

- 671c2fc: `rig fund` UX remediation + CLI polish (#280):

  - **`rig fund` names the right knob first.** On a `custom`/unset network
    without a faucet, the guidance now leads with `TOON_CLIENT_NETWORK=devnet`
    (the actual fix for the shared devnet — no faucet URL needed) and frames
    `TOON_CLIENT_FAUCET_URL` as the self-hosted-network override. When a
    configured relay/proxy/BTP origin is under `*.devnet.toonprotocol.dev`, the
    message says so explicitly.
  - **Calm stderr on paid commands.** The embedded client's expected
    `[Bootstrap] Announce failed … 402 Payment Required` x402 dump is reframed
    as one plain-language info line (harmless, the command continues); repeats
    are dropped, non-402 announce failures still pass through. Internal issue
    numbers are gone from user-facing warnings.
  - **`rig pr create --body <text>` / `--body-file <path>`.** The PR
    description rides in a dedicated `description` tag on the kind:1617 event —
    never in the content, which stays pure `git format-patch` output so
    `git am` keeps applying it (git's patch-format detection hard-fails on
    leading prose). `rig pr show` renders the body as its own section and
    carries it in the `--json` envelope.

## 2.1.0

### Minor Changes

- c17e824: Full client money lifecycle in the CLI (#263): `rig fund`, `rig channel open|close|settle`, and `rig balance`. `rig fund` drips devnet faucet funds to the active identity's wallet (`POST {faucet}/api/request` with the derived chain address; faucet from `TOON_CLIENT_FAUCET_URL` → config `faucetUrl` → the deployed devnet faucet when `network` is devnet) and, on networks without a faucet, prints the wallet address(es) to fund externally. `rig channel open` runs the SAME resume-or-open path paid writes use lazily (recorded in the #262 peer→channel map; `--peer` anchors to an explicit ILP destination, `--deposit` adds collateral); `close`/`settle` drive the client's on-chain withdraw flow over recorded channels — close starts the settlement challenge window, settle releases collateral after it (refused locally, without gas, while the window is open) — recovering deposits stranded by pre-#262 one-channel-per-run behaviour. `rig balance` joins the client's settlement-chain-aware wallet readers with per-channel deposited/claimed/available from the map + claim watermark, uplink-free. On-chain commands follow the push confirm idiom (`--yes` required non-interactively; `--json` without `--yes` is a pure plan) and report the identity chain in their `--json` envelopes.
- b96f186: Real network bootstrap for standalone paid commands (#264, closing out #260's bootstrap root causes): rig now upgrades to `@toon-protocol/core` ^2.0.1 (live devnet genesis seed) and resolves the payment topology from the network instead of hand-fed constants, in strict `explicit config > live kind:10032 announce > genesis seed` order.

  - **Announce discovery**: paid commands discover the payment peer's kind:10032 `IlpPeerInfo` announce on the relay-origin (the relay resolved via `rig remote`). The announce supplies the uplink (`httpEndpoint`/`btpEndpoint`), the channel anchor (`ilpAddress`), the publish/store ILP routes (`routes` map — replacing the #228-era `<base>.relay.store` derivation as the default), and the peer's `supportedChains`/`settlementAddresses`.
  - **tokenNetwork fallback** (#260): per-chain TokenNetwork/token/RPC parameters the announce omits are derived — explicit config > announce > canonical devnet endpoint table > core's deterministic chain presets (matched by chain id) — and back-filled into the client's peer negotiation before the channel opens. A selected EVM chain whose TokenNetwork stays underivable fails with a clear error naming the announce, chain, and relay.
  - **Settlement-chain selection** (#260): explicit config (`TOON_CLIENT_CHAIN`/`chain`/`supportedChains`) > the chain of a live persisted #262 channel > the first announced EVM chain where the wallet holds tokens > the first announced EVM chain, with a printed rationale. The `network` preset field is no longer forwarded to the embedded client (its preset-first chain ordering steered devnet writes to the unfunded public Solana preset).

  Out of the box, `rig init` + `rig remote add origin <relay>` + a faucet-funded identity now completes a paid `rig push` on devnet with no destination/anchor/tokenNetwork/chain configuration.

- 2c2cb1f: Persist the peer→channel mapping so standalone rig reuses payment channels across invocations (#262). Paid commands now record the channel they lazily open in `TOON_CLIENT_HOME/rig-channels.json` (keyed by identity pubkey + peer destination + chain + tokenNetwork) and RESUME it on the next run — `trackChannel` rehydrates the cumulative-claim watermark from the client's `channels.json` — instead of opening (and funding) a fresh on-chain channel per CLI invocation. A corrupt map file refuses the paid operation before anything is opened. New free command: `rig channel list [--json]` shows recorded holdings (peer, chain, channel id, deposit, cumulative claimed, withdraw status).

### Patch Changes

- e9719e5: Strict `--json` stdout (#265, closes the #260 addendum): when `--json` is set on a rig-owned command, stdout carries exactly one parseable JSON document — a machine-readable guarantee for agent consumers (`rig … --json | jq`). A process-level stdout guard reroutes every stray write (including dependencies' `console.log`, e.g. the embedded client's `[Bootstrap] …` lines) to stderr; the io layer sends all human chatter (identity reports, deprecation nudges, migration hints, chain-selection rationales, discovery warnings) to stderr; errors emit one machine envelope on stdout plus human detail on stderr with a non-zero exit; and a backstop envelope covers paths that bail before emitting (usage errors, pre-payment refusals). `rig remote add/remove` gain proper `--json` envelopes. The git passthrough is exempt and documented as such (`rig status --json` is `git status --json`; `rig --json status` passes through untouched). An enforcement matrix test runs every rig-owned command in `--json` mode and asserts the single-document guarantee, with the noisy paths exercised deliberately.

## 2.0.1

### Patch Changes

- 9afc439: Make `npm i -g @toon-protocol/rig` actually work from the registry (#259).

  - `@toon-protocol/arweave` moves from `dependencies` to `devDependencies`: tsup already inlines it (code and types) into dist, but the leftover runtime entry got its `workspace:*` rewritten to a concrete version of a then-private package at publish time, so rig 2.0.0 shipped a hard dependency on an unpublished package and every fresh `npm i -g` died with E404. (`packages/arweave` is also no longer `private`, so the registry gains `@toon-protocol/arweave@0.2.0` and already-published consumers that pin it — rig 2.0.0, views 0.13.1 — become retroactively installable.)
  - `@toon-protocol/client` is now a regular runtime dependency instead of an optional peer: the CLI is standalone-only (#248) and needs the client for identity derivation and every paid command, so installation must pull it automatically. The dynamic imports stay (startup code-splitting), but the "install the optional peer and re-run" failure mode is gone.

## 2.0.0

### Major Changes

- 3629992: Git passthrough + BREAKING `rig status` → `rig pr status` (#250).

  **BREAKING — the NIP-34 status publish moved:** `rig status <target-event-id> <open|applied|closed|draft>` (the paid kind:1630–1633 publish) is now **`rig pr status <target-event-id> <state>`**. Bare `rig status` no longer publishes anything — it passes through to `git status`. Update scripts accordingly; flags (`--yes`, `--json`, `--remote`, `--relay`, `--repo-id`, `--owner`) and the `--json` receipt shape are unchanged apart from `command: "pr status"`.

  - NEW git passthrough: any subcommand rig does not own is executed as `git <argv...>` verbatim — `rig add -p`, `rig commit -m`, `rig log --oneline`, `rig diff`, `rig branch`, `rig checkout`, `rig rebase -i`, everything. The child git runs with `stdio: 'inherit'` (interactive commands, pagers, colors, prompts all work), rig's exit code is git's exit code exactly (signal deaths map to 128+N), and SIGINT/SIGTERM/SIGHUP are relayed so git controls the outcome of a Ctrl-C. A missing system git is a clear error (exit 127).
  - rig-owned verbs always win: `init`, `remote`, `push`, `issue`, `comment`, `pr`, `help`/`-h`/`--help`, and the new `--version`. In particular `rig push` remains the paid TOON push and shadows `git push` — plain-git pushes stay available by running `git push` directly.
  - `rig help` now lists the owned verbs and states that any other command is passed through to git (`rig status` → `git status`).

- d10965e: Standalone-only CLI + RIG_MNEMONIC identity chain + `rig init` (#248).

  BREAKING:

  - Daemon mode is removed from the `rig` CLI: the `--daemon`/`--standalone` flags, the toon-clientd `/status` probe with automatic mode selection, and the CLI's loopback `/git/*` HTTP client are gone. Every command publishes through the embedded, nonce-guarded StandalonePublisher. The daemon's `/git/*` routes and `toon_git_*` MCP tools are unaffected (that's the MCP host path), the shared wire types in `routes.ts` stay exported, and the nonce guard still refuses when a running toon-clientd holds the same identity.
  - Repo config is no longer written as a side effect of the first push. `rig push` and the single-event commands now error with "run `rig init` first" when `toon.repoid` is unconfigured (`--repo-id`/`--owner`/`--relay` flag overrides keep working), and never mutate git config.
  - Human/JSON output no longer carries a `mode` field; paid commands now report the active identity (`identity: { pubkey, source, sourceLabel }` in `--json`; an `Identity:` line in terminal output). The phrase itself is never printed or persisted.

  NEW:

  - Identity resolution precedence: `RIG_MNEMONIC` env > `TOON_CLIENT_MNEMONIC` env (deprecated alias, warns on stderr) > project-local `.env` (walked up from the working directory; ONLY the `RIG_MNEMONIC` line is parsed — never arbitrary env, never required) > `~/.toon-client` keystore/config.
  - `rig init`: one-shot, idempotent repo setup — verifies the git repo (hints at `git init`, never runs it), resolves the identity chain (errors with all three remediation options), writes `toon.repoid` (default: directory basename, `--repo-id` overrides, existing value kept on re-runs) and `toon.owner` (derived pubkey) to the LOCAL git config, and prints the relay follow-up when none is configured. `--json` supported.

### Minor Changes

- 121e8f9: Relays as origins (#249): configure relays as REAL git remotes and push to them like git.

  - NEW `rig remote add <name> <relay-url>` / `rig remote remove <name>` / `rig remote list [--json]` — mapped onto real `git remote` storage, so `git remote -v` shows them and plain git tooling round-trips the config (no parallel store). Junk URLs (anything but ws/wss/http/https) are rejected at add time; adding over an existing name is refused with a `git remote set-url` hint.
  - `rig push [remote] [refspecs...]` — git-like remote resolution: when the first positional matches a configured remote name it is the push target, otherwise it is a refspec and the remote defaults to `origin`. No usable remote → clear ``no origin configured — run `rig remote add origin <relay-url>` `` error. The event commands (`issue`/`comment`/`pr`/`status`) take `--remote <name>` (default `origin`).
  - `--relay <url>` stays as an ad-hoc override on every paid command — it bypasses the configured remotes entirely.
  - One relay URL per remote: a git remote with multiple URLs (`git remote set-url --add`) is refused BEFORE anything is fetched, uploaded, or paid.
  - Migration off `toon.relay` (deprecated, removed in v0.3): paid commands still fall back to it when no relay `origin` exists, printing a one-line migration nudge; `rig init` now migrates a single-valued `toon.relay` to a real `origin` remote automatically (the old key stays readable) and suggests `rig remote add origin <relay-url>` as the follow-up step when nothing is configured. Paid commands no longer silently fall back to the network-default relay.

## 1.0.0

### Minor Changes

- 508aa4d: Push planner/executor for the Rig write path (#226).

  `planPush({ repoReader, remoteState, feeRates, repoId, refs?, force? })`
  classifies every ref update (new / fast-forward / forced via `isAncestor`;
  non-fast-forward without `force` throws `NonFastForwardError` with the
  offending refs), computes the object delta (`objectsBetween` minus the
  remote's `arweave` sha→txId hints, with an injectable `resolveMissing` step
  for SHAs the tags don't cover), hard-errors on objects over the 95KB limit
  (`OversizeObjectsError` carries path + size per object), and returns a
  `PushPlan` with the full new ref state, upload list (ref tips ordered last),
  and a fee estimate (Σ bytes × uploadFeePerByte + per-event fees, announce
  included on first push).

  `executePush({ plan, publisher, remoteState, repoReader, relayUrls })`
  uploads the planned objects through the new `Publisher` interface
  (implemented by the daemon in #227 and the standalone client in #228), then
  publishes ONE cumulative kind:30618 whose `arweave` tags MERGE the remote's
  existing map with the new uploads (NIP-33 replaceable — prior hints are
  never dropped) and whose `r` tags carry the full new ref state, preceded by
  a kind:30617 announcement on first push. Content-addressed uploads make
  re-running after a crash safe: SHAs already in the merged map are skipped
  without paying.

  `GitRepoReader` gains `objectsBetweenWithPaths` (reach paths for actionable
  oversize errors) and `statObjects` (type + size via one
  `cat-file --batch-check` pass, no bodies).

- 3f30e36: Remote-state reader for the Rig write path (#225).

  `@toon-protocol/arweave` now owns the Git-SHA → Arweave txId GraphQL resolver
  (`resolveGitSha`, `seedShaCache`, `clearShaCache`, `shaCacheKey`,
  `isValidArweaveTxId`), extracted from rig's `web/arweave-client.ts` so the
  browser SPA and the Node write path share one implementation. Rig re-exports
  them from the same path, so its importers are unchanged.

  `@toon-protocol/git` gains `fetchRemoteState({ relayUrls, ownerPubkey, repoId })`:
  a NIP-01 WebSocket query for the repository's kind:30617 announcement and
  kind:30618 state (latest per NIP-33 replaceable semantics; tolerates inline
  JSON, double-JSON-encoded, and TOON-encoded EVENT payloads), returning the
  ref map, HEAD symref, `arweave` sha→txId hints, announcement metadata, and a
  `resolveMissing(shas)` helper backed by the shared GraphQL resolver.

- 453f734: Standalone embedded Publisher + daemon-collision nonce guard (#228).

  New `@toon-protocol/git/standalone` subpath export (the core entry stays
  dependency-light — `@toon-protocol/client` is an OPTIONAL peer dependency
  needed only by this entry): `StandalonePublisher` implements the `Publisher`
  interface over an EMBEDDED `ToonClient` built from the caller's config
  (mnemonic + account index, the `packages/client/src/config.ts` shape) for
  CI/servers/one-shot CLI runs with no toon-clientd. Publishes sign with the
  derived Nostr key and pay one balance-proof claim per write at the flat
  per-event fee; `uploadGitObject` mirrors the proven seed pipeline (kind:5094
  store write tagged Git-SHA/Git-Type/Repo, bytes × per-byte bid, routed via
  `proxyPath: '/store'`, Arweave txId decoded from the FULFILL — HTTP-enveloped
  or legacy bare form); `getFeeRates` reports the configured flat event fee +
  per-byte upload rate. Publish/store routes derive from the channel anchor with
  the daemon's `<base>.relay.store` convention.

  Nonce-ownership guard (the load-bearing piece): the payment channel's
  cumulative-claim watermark tolerates exactly ONE writer per identity, so
  before any paid operation the publisher (1) probes the toon-clientd loopback
  control API (`GET /status`, port 8787 / `TOON_CLIENT_HTTP_PORT`) and REFUSES
  with `DaemonIdentityConflictError` when a running daemon reports the same
  Nostr pubkey — use daemon mode or stop the daemon — and (2) holds an exclusive
  per-pubkey advisory lockfile (`standalone-<pubkey>.lock` under
  `~/.toon-client` / `TOON_CLIENT_HOME`) against other standalone processes,
  with stale-lock reclaim by dead-pid detection, released on `stop()` and
  process exit.

- 5e9e0df: `rig issue|comment|pr|status` subcommands (#231): single NIP-34 event publishes over the same two publisher modes as push — daemon (`POST /git/issue|comment|patch|status`) and standalone (local builders + the nonce-guarded embedded publisher, with the pre-pay single-relay guard). Repo addressing (`30617:<owner>:<repoId>`) resolves from the `toon.*` git config keys `rig push` persists, with `--repo-id`/`--owner` overrides and an actionable error when unconfigured. `rig pr create --range` publishes REAL `git format-patch --stdout` output as the kind:1617 content (one event per series; commit/parent-commit tags derived from the patch itself; `--patch-file` publishes verbatim). All four quote the per-event fee (daemon `/status` `feePerEvent` or standalone fee rates) behind the same confirm gate as push (`--yes`, non-TTY refusal, `--json` estimate). Also exports the single-event `/git/*` wire types (`GitRepoAddr`, `Git{Issue,Comment,Patch,Status}Request`, `GitEventResponse`) + `serializeEventReceipt` from `routes.ts`, and adds `GitRepoReader.commitParents`.
- 74f45a7: `rig` CLI bin (#229): `rig push [refspecs...]` with the estimate → confirm → execute flow — fee table (refs, objects, bytes, itemized + total; permanent + non-refundable), `--force`/`--all`/`--tags`/`--yes`/`--json`/`--relay`/`--repo-id`, automatic daemon (toon-clientd `/git/*` routes) vs standalone (embedded nonce-guarded client) publisher selection with `--daemon`/`--standalone` overrides, structured error UX (non-fast-forward → `--force` hint, oversize objects → paths+sizes + #235, funding/daemon-down remediation), and `rig init`-lite persistence of `toon.repoid`/`toon.owner`/`toon.relay` git config after the first successful push. Also exports the `/git/*` wire types + `serializePushPlan`/`serializePushResult` from a new `routes.ts` so `@toon-protocol/client-mcp` can adopt them.

### Patch Changes

- Updated dependencies [68a7150]
- Updated dependencies [3f30e36]
- Updated dependencies [1ff6370]
  - @toon-protocol/client@0.15.0
  - @toon-protocol/arweave@0.2.0
