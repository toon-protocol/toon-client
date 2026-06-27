---
"@toon-protocol/views": patch
"@toon-protocol/client-mcp": patch
---

Fix three wallet-overview bugs that made the wallet card look broken in the host iframe:

- **Copy button was a silent no-op.** The TOON app runs in the host iframe, which
  isn't granted the `clipboard-write` permission policy, so
  `navigator.clipboard.writeText` rejects there — and the click had no rejection
  handler. `CopyButton` now falls back to the legacy `document.execCommand('copy')`
  over a hidden textarea (works in a sandboxed frame), same iframe-limitation
  class as the `window.confirm` → consent fix.
- **Fund button gave no feedback.** Tapping "Fund" fired the faucet but the card
  never changed, so it read as broken. The button now shows a `Funding…` →
  `Requested` (or `Retry fund` on failure) state and re-reads balances after a
  successful drip.
- **Balances rendered blank on a flaky read.** The `toon_balances` control plane
  can transiently refuse on `:8787` while the websocket transport is healthy
  (toon-client#186) — it succeeds on retry. `readBalances` now retries before
  giving up and throws on persistent failure, and `wallet-overview` shows a
  "Balances temporarily unavailable — Retry" state instead of a blank card that's
  indistinguishable from a real zero balance.

Also fixes the daemon-side root cause of that flakiness (toon-client#186), not
just the symptom:

- **Stale keep-alive socket race.** The long-lived MCP server calls the localhost
  control plane infrequently, so the daemon (Node's default 5s keep-alive) reaped
  idle sockets the undici client pool still held — the next request reused a dead
  socket and failed with `ECONNRESET`, mislabeled as "daemon not reachable". The
  daemon now keeps idle sockets alive past the client's pool window
  (`keepAliveTimeout: 650s`), and the `ControlClient` transparently retries
  idempotent (GET/DELETE) requests on a transient connection failure. Mutating
  POSTs are not retried (no double publish/fund/deposit).
- **Timeouts no longer masquerade as "daemon not reachable".** A request the
  client aborts on its own timeout (e.g. a hung on-chain balance read) is now a
  retryable `504`, so the surfaced message says "retry" instead of "the daemon
  failed to start — check the log".
- **The real reason the wallet showed no balance: tool results carried no
  `structuredContent`.** The MCP-app iframe bridge only surfaces a tool's
  `structuredContent` as `ToolOutcome.data`; `toon_balances` / `toon_channels`
  (and every write receipt) returned text-only, so the atoms' read seams got
  `undefined` → `wallet-overview` rendered addresses but no balance/USDC and no
  error (indistinguishable from an empty read), and deposit/withdraw/publish
  receipts came back blank. The `ok()` tool-result helper now mirrors object
  payloads into `structuredContent`, fixing the whole class. (The model still
  saw the text, which is why balances "read zero" in chat but never reached the
  card.)
