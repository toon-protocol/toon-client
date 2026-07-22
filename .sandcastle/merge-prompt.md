# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run toon-client's gate to verify everything works — in order: `eslint .`, then `pnpm -r run build`, then `pnpm run typecheck`, then `vitest run` (build must precede typecheck so cross-package `dist/*.d.ts` exist). `typecheck` is a SOFT gate with ~82 known pre-existing errors (#423) — the merge must not ADD new ones; `lint`, `build`, and `test` must be green.
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`gh issue close <ID> --comment "Completed by Sandcastle"`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
