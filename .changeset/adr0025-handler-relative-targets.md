---
'@toon-protocol/client': minor
---

Envelope targets are now handler-relative (ADR 0025), which is what makes a
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
