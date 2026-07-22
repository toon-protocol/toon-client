# TASK

The reviewer just committed refinements on branch `{{BRANCH}}`. Push them to
origin so the open pull request picks them up. **Do NOT merge, close, or open a
new PR.**

# STEPS

1. Confirm the branch has commits to push:

   !`git log origin/{{BRANCH}}..{{BRANCH}} --oneline`

   If there is nothing ahead of `origin/{{BRANCH}}`, output
   `<promise>COMPLETE</promise>` and stop.

2. Wire `git push` authentication so the push below is NOT unauthenticated.
   `gh` is authenticated from `GH_TOKEN`, but a bare `git push` uses git's own
   credential system. Install `gh` as git's credential helper (idempotent; the
   onSandboxReady hook already did this, but re-run it here so this step is
   self-contained):

   `gh auth setup-git`

3. Push, then CONFIRM the remote branch advanced — a push can fail without an
   obvious error:

   `git push origin {{BRANCH}}`
   `git log origin/{{BRANCH}}..{{BRANCH}} --oneline`

   If the second command still prints commits (i.e. the branch is STILL ahead of
   `origin/{{BRANCH}}` after the push), the push FAILED. Do **not** output
   `<promise>COMPLETE</promise>` — print the push error and stop. The runner
   verifies from the host and will fail the job.

# RULES

- Never run `git merge`, `gh pr merge`, or `gh issue close`.
- Do not open a new PR — the existing PR updates automatically from the push.
- Only output `<promise>COMPLETE</promise>` once the push is confirmed landed
  (step 3). A failed push is a failure, not a COMPLETE.

Once pushed and confirmed, output `<promise>COMPLETE</promise>`.
