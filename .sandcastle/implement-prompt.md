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

## Typecheck is a SOFT gate (known pre-existing debt)

`pnpm run typecheck` has ~82 pre-existing errors on `main` (tracked in #423), most of them in `rig-web`. Do **not** try to clear that backlog inside this issue. The rule is narrower: **your change must not ADD new type errors.** Check the delta — run `pnpm run typecheck` before and after your change (or scope it to the package you touched, e.g. `pnpm --filter @toon-protocol/client run typecheck`) and confirm you introduced none. `lint`, `test`, and `build` must be fully green.

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
