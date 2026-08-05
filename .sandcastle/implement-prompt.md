# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

toon-client is a large pnpm monorepo (packages: arweave, client, client-mcp, rig, rig-web, views). Before committing, run its real gate and make sure it passes. **Run them in this order** — `build` MUST precede `typecheck` because the per-package `tsc --noEmit` resolves cross-package imports through each dependency's built `dist/*.d.ts`:

- lint: `eslint .`
- build: `pnpm -r run build`
- typecheck: `pnpm run typecheck` (runs `tsc --noEmit` recursively in every package, including `rig-web`)
- test: `vitest run`

## Lint and typecheck are gated MECHANICALLY against a frozen baseline

The pre-existing lint/typecheck debt (tracked in #423) is frozen in
`.sandcastle/gate-baseline.json`, and CI enforces it — this is not a soft delta you eyeball.
ci.yml's `build` job runs `npx eslint . -f json` and `pnpm -r --no-bail run typecheck` (both
`continue-on-error`), then `.sandcastle/gate-guard.ts` compares the measured counts against the
frozen baseline and **fails the job on any NEW violation**:

- eslint: more errors or more warnings than the frozen counts fails (currently 16 errors /
  718 warnings — read `gate-baseline.json` for the live numbers).
- typecheck: more total errors than frozen fails (currently 75), and every package is capped
  individually (`rig` 1, `rig-web` 74, all others 0) — a new error in one package is a FAIL
  even if you fixed one somewhere else.

Do **not** try to clear the frozen backlog inside this issue, and do **not** edit
`gate-baseline.json` to get green. Your change must add zero new eslint or typecheck
violations: check the counts before and after (`npx eslint .`, `pnpm run typecheck`; or scope
typecheck to the package you touched, e.g. `pnpm --filter @toon-protocol/client run typecheck`,
which must stay at its per-package cap). `test` and `build` must be fully green.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

## Changesets

toon-client publishes several packages and CI enforces a changeset when a publishable package changes (`packages/client`, `client-mcp`, `views`, `rig`, `arweave`). If you touched any of those, run `pnpm changeset` and commit the generated `.changeset/*.md` so the PR is mergeable. (Changes confined to `rig-web`, tooling, or docs need none.)

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.

## Context budget

Operate as if your context is capped at **~200k tokens**, whatever your model's actual window
is (org policy: toon-meta's `CLAUDE.md` → *Context budget policy* — the cap is absolute, not a
percentage of the window, because a percentage means different things on different models).
Treat ~200k as a hard ceiling, not a target, and do the real work well below it.

Start preparing a handoff at roughly **120k** tokens of context, and hand off no later than
roughly **160k** — never run to the ceiling. Handing off means: write a structured handoff note
(goal and remaining work as a concrete task list; what has been done and where — files,
branches, commits; key decisions and why; exact paths/line numbers instead of "see above") to
`.sandcastle/logs/handoff-<task-id>.md`, **commit it on this branch** (use `git add -f` —
`.sandcastle/.gitignore` ignores `logs/`, and the sandbox is destroyed when the run ends, so an
uncommitted note is lost), and end your turn so a fresh agent continues. Small, resumable units
beat one degraded run.
