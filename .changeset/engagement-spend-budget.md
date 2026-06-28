---
'@toon-protocol/views': patch
---

Add a pre-authorized engagement spend-budget so cheap social micro-writes don't prompt per-action.

Likes (kind:7), follows (kind:3) and reposts (kind:6) each settle a payment-channel claim, which makes the full per-action consent modal far too heavy for high-frequency actions. The user now approves a small allowance ONCE per session; engagement micro-writes then debit a local counter silently until it runs out, at which point we re-prompt to top up. Bigger writes (compose/post, upload, swap, channel ops) keep their per-action consent.

- New `BudgetProvider` / `useEngagementGate` / `useEngagementBudget` (`engagement-budget.tsx`), layered over `ConsentProvider`: a one-time "allow up to X {asset}" prompt on the first engagement, a session-only debit counter (never persisted, so a stale reload can't keep spending), and a top-up re-prompt on exhaustion. It reuses the same `toon_status` fee/asset read seam and falls back to the per-action consent when the fee is unavailable.
- The runtime routes a spendy publish through the budget gate only when it's an engagement kind (3/6/7) — scoped by event semantics, not tool name, since like/follow/repost share `toon_publish_unsigned` with compose/profile-edit. A host-injected `confirm` still wins. `BudgetProvider` is mounted in `ViewSpecRenderer` alongside `ConsentProvider`.
- `note-card`'s engagement bar gains a subtle "remaining budget" affordance (with a tap-to-top-up control) once an allowance is authorized.
