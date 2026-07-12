---
'@toon-protocol/client-mcp': minor
---

Wire the rolling-swap sender-side defenses into the daemon (#351, toon-meta#145, sdk 2.1.0):

- **Hard floor** — `SwapRequest.minExchangeRate` (explicit) or `floorBps` (derived `pair.rate × (1 − bps/10000)`, exact decimal math); a below-floor packet surfaces `BELOW_FLOOR` + `abortReason: 'below-floor'` and the armed floor is echoed on the response for host consent surfaces. Both floor params are also on the `toon_swap` MCP schema.
- **Adaptive controller** — `SwapRequest.controller` (or daemon `swapDefaults.controller`) engages the sdk `AdaptiveDeltaController` for dynamic δ/W packet sizing; per-(source chain, maker, pair) state persists in `<configDir>/swap-controller-state.json` beside the channel stores and resumes across swaps and restarts.
- **Telemetry** — `onPacket` is now wired: per-packet outcomes (`packets`, capped at 500), `rejections`, `abortReason`, and a `realizedRate` summary land on `SwapResponse`; accepted packets are logged.
- **Abort + expiry** — `SwapRequest.timeoutMs` arms an `AbortSignal` (partial fills reported exactly); `packetExpiryMs` stamps deterministic per-packet PREPARE expiries.
- **Daemon defaults** — new `swapDefaults` config block (`floorBps`, `packetExpiryMs`, `controller`); per-request values win, an explicit `packetCount` pins the legacy even split, and with nothing configured the `streamSwap` request is unchanged. Composes with `senderConditions` (#354).
