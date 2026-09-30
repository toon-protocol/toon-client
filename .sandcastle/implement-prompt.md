/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `CLAUDE.md` covers the layout and the commands, `CONTEXT.md` is the vocabulary (each entry
  carries an `_Avoid_` list, which is a hard constraint on your wording), and `docs/adr/` settles
  most questions that look like they need a human. The committed wire vectors under
  `packages/client/src/wire/vectors/` are normative; prose is not.
- It is a pnpm workspace (`pnpm@9.12.3`). Dependencies are already installed, frozen.
- After you finish, the runner runs CI's `build` job itself and won't open a PR while it is red,
  in this order: `npx eslint .`, `pnpm -r build`, `pnpm -r --no-bail run typecheck`,
  `pnpm -r test --if-present`, `npx vitest run .sandcastle/ .github/rig-web-redirect/`, then
  `.sandcastle/gate-guard.ts`. Run them yourself before you commit. Build before typecheck, so
  `tsc` resolves against built `dist/*.d.ts`. Never weaken, skip or ignore a test, and never
  loosen a lint, to get green.
- Lint and typecheck debt is frozen in `.sandcastle/gate-baseline.json`, and the guard fails on
  any new violation. Do not clear the backlog inside this issue and do not edit the baseline.
- If you touched `packages/client`, run `pnpm changeset` and commit the generated
  `.changeset/*.md`, or CI's changeset check fails. Tooling and docs changes need none.
- The sandbox is the shared factory image: Node 22, pnpm via corepack, gh, Rust, Foundry
  (`anvil`, `cast`) and the Solana CLI v2.1.21. CI's `batch-settlement-exit` job needs
  `solana-test-validator` v3.1.12, which cannot run in this sandbox, so that job is CI-only and is
  not part of the runner's gate. A change that touches settlement can pass here and still be
  caught by CI. A suite that reports `0 tests` or `skipped` did not run. Treat that as a failure.
- A ticket that needs a funded key, a live devnet connector or a credential no workflow exposes
  is one you cannot finish: see below.

## When you cannot finish

Stop only when a genuinely new decision is needed and no ADR covers it, the action is
irreversible, it touches mainnet or real funds, or it needs a credential that no workflow
exposes. In that case, commit nothing and explain what blocks you in a comment on the issue
(`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits to
`needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.

If you stopped because you're blocked, output <promise>BLOCKED</promise> instead, after your
comment on the issue. The runner then ends the run. Otherwise it starts another session, which
hits the same blocker and posts the same comment again.
