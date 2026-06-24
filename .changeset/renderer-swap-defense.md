---
'@toon-protocol/client': minor
---

Add the renderer-swap defense — a fail-closed security guard around render dispatch for the NIP-on-TOON render trust gradient (toon-client#91, toon-meta#58).

A `kind:31036` renderer is *addressable*: the coordinate `31036:<author-pubkey>:<targetKind>` can later resolve to a different event/`id`. Because the resolved renderer selects both the render strategy and the trust tier, a malicious 31036 that gets selected can attack the user. The new `verifyRendererTrust(...)` guard runs between renderer resolution and `renderDispatch`, and refuses (fails closed — the caller drops to native for known kinds, generative for unknown kinds) on any violation:

- **Author binding** — the resolved 31036's `pubkey` (and the `ui` coordinate's author segment) MUST equal the event author (the authoritative renderer author per toon#36); cross-author substitution is rejected.
- **Signature verification** — the 31036 signature is re-verified (`verifyEvent`) before it can select a strategy; tampered/unsigned renderers are rejected (and a throwing verifier fails closed).
- **Deterministic selection** — candidate revisions are collapsed with `selectLatestAddressable` (latest `created_at`, lowest-`id` tiebreak, NIP-01), so selection is not attacker-race-controllable.
- **Anti-swap pinning + downgrade detection** — the chosen renderer `id`/trust tier is pinned per coordinate in a `RendererPinStore`; a later differing `id` is a detected swap. A trust-lowering swap is refused; for high-trust (branch-1 known) kinds *any* `id` change is refused and falls back to the native component. The pin store can be seeded from config to allowlist a high-trust renderer by `event.id`.

Adds `guardedRenderDispatch(...)` as the secure entry point that wires the guard around `renderDispatch` and never passes a suspect renderer through.

The `UiCoordinate` helpers (`getUiCoordinate` / `selectLatestAddressable` / `UiCoordinate`) are imported directly from `@toon-protocol/core@1.6.0` (the dep bump landed in #97, which also dropped the local `constants.ts` mirror). The guard shares those primitives with the `resolveUiRenderer` resolver (#97) — so the two agree bit-for-bit on coordinate selection and signature acceptance — and layers the anti-swap pin store plus granular fail-closed rejection reasons on top, rather than re-deriving resolution as a parallel copy.
