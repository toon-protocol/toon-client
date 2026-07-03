---
'@toon-protocol/rig': minor
---

`rig fund` funds ALL supported chains by default (#309). A plain `rig fund` now
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
