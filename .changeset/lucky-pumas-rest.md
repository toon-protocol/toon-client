---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
---

Resolve `@toon-protocol/core` at `^3.2.1` and `@toon-protocol/sdk` at `^3.1.6` (previously `^3.2.0` / `^3.0.0`), so shipped clients pick up toon#165's fix: `resolveClientNetwork` and `createNode`'s default `settlementInfo` now emit the bare `evm:<chainId>` settlement identifier the live fleet and the x402 greeting actually use, instead of the family-qualified `evm:base:<chainId>`.

`client-mcp` inlines `core`, `sdk`, and the workspace `rig` at build time (`tsup`'s `noExternal`), so — same failure mode as the `0.36.5` stale-genesis-seed incident — a satisfiable dependency range alone does not move the shipped bundle. Bumping the range in `client`, `client-mcp`, and the workspace-only `rig` (which `client-mcp` pulls in via `workspace:*`) and republishing is what actually rebakes the fix into the artifact Claude Desktop and Claude Code run.

Without the family segment, chain-key equality is now exact between the client's default settlement chains and the apex's `kind:10032` announce, so negotiation no longer silently falls through to `solana:devnet` (the original #165 symptom: a misleading "Solana settlement wallet holds 0 lamports" error that pointed at funding when the cause was identifier format).
