---
---

CI only — no published behaviour changes, so this changeset is deliberately
empty rather than bumping `@toon-protocol/client` for a workflow.

The receive-side Solana settlement proof added in toon-client#605 now runs in
CI, on a real `solana-test-validator`, on every pull request and every push to
`main`, and `CI OK` requires it. It previously ran nowhere: the suite skips when
no validator is on PATH, and no CI job ever installed one, so the only evidence
that a received Solana claim can be redeemed was a developer's local run.

The `packages/client` change is `tsconfig.integration.json`, a second project
config that typechecks the integration suites. `tsconfig.json` excludes
`**/*.test.ts`, so `pnpm typecheck` reads no test file in this package —
including the 800-line proof. The package's own `typecheck` script and its
frozen zero-error baseline are untouched; the new config is read by the new CI
job only. It surfaced a real drift, filed as #607.
