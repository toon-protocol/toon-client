# TASK

Repair pull request #{{PR_NUMBER}} on branch `{{BRANCH}}` so its checks pass and it is
mergeable.

You were dispatched by the factory's PR repair pass (toon-meta#357): this PR's ONLY
blocker(s) are a merge conflict and/or failing checks — every other precondition
(approval, review state, `needs:human`) already holds. Make the smallest change that
gets it green; do not expand scope.

# DIAGNOSE

First, find out exactly why this PR is red:

    gh pr view {{PR_NUMBER}} --json mergeable,statusCheckRollup

- If `mergeable` is `CONFLICTING`, resolve the conflict against `main` (see CONFLICTS
  below).
- For every failing check, read its logs before touching anything:

      gh run view <run-id> --log-failed

  (`<run-id>` is the numeric id in the failing check's `detailsUrl`.)

# CONFLICTS

If the PR conflicts with `main`:

    git fetch origin main
    git merge origin/main

Resolve conflicts by reading BOTH sides and choosing the resolution that preserves both
changes' intent (the same convention `.sandcastle/merge-prompt.md` uses) — never blindly
take "ours" or "theirs". If a conflict needs a judgement call only a human should make,
say so plainly in your final output instead of guessing.

# FAILING CHECKS

This is **toon-client** — a single-package pnpm workspace (`packages/client`, published
as `@toon-protocol/client`). The PR checks that can go red live in ci.yml's `build` job.
Reproduce locally, **in this order** — `build` precedes `typecheck` so `tsc --noEmit`
resolves against a built `dist/*.d.ts`:

- lint: `npx eslint .`
- build: `pnpm -r run build`
- typecheck: `pnpm run typecheck`
- test: `pnpm -r test --if-present`

Lint and typecheck are gated MECHANICALLY against a frozen baseline: the pre-existing
debt is frozen in `.sandcastle/gate-baseline.json` and `.sandcastle/gate-guard.ts`
fails the job on any NEW violation. The fix must add ZERO new eslint or typecheck
violations against the frozen counts — do NOT edit `gate-baseline.json` to get green.
`test` and `build` must be fully green.

CI also enforces a changeset when the publishable package changes (`packages/client`):
a missing-changeset failure is fixed with `pnpm changeset` and committing the generated
`.changeset/*.md` — never by reverting the package change just to dodge the check.

The `Agent image` check (a build-only check over `.sandcastle/Dockerfile`) runs only on
PRs touching `.sandcastle/**` or that workflow itself.

Fix the ROOT CAUSE of the failure, not the symptom — e.g. a real type error means fix
the code, not the baseline that caught it. If a failing check looks like infrastructure
flakiness (a CDN, package registry, or setup-step timeout with no code-level cause), say
so plainly in your final output instead of inventing a change just to make the diff
"look different."

# EXECUTION

1. Diagnose the actual cause before editing anything.
2. Make the smallest change that fixes it.
3. Re-run the failing part of the gate locally (in the order above) and confirm it
   passes before you consider the job done.
4. Commit on the current branch (`{{BRANCH}}`) — this is the PR's own branch; do not open
   a new PR.
5. Do not touch anything outside what's needed to turn this PR green.

Once you've made your fix commit(s) (or determined the failure is not fixable from this
branch — say so clearly in your final output), output <promise>COMPLETE</promise>.
