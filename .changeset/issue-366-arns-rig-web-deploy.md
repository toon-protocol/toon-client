---
---

rig-web: add an additive, opt-in ArNS step to the permanent Arweave deploy (`src/web/arns-deploy.ts`) so a stable `https://<name>.<gateway>/#relay=…` URL points at each redeploy's manifest txId instead of an unreadable, ever-changing raw txId. One-time quote/buy (`getTokenCost`/`buyRecord`) and per-redeploy `setBaseNameRecord` via an injected `@ar.io/sdk` client; guarded on `RIG_ARNS_NAME`. All money-moving paths are mock-tested only — no real registry call and no funds spent.
