---
'@toon-protocol/rig': patch
---

fix(rig): `rig init --git-init` now creates `main` deterministically (was
`master` on a stock git without `init.defaultBranch=main`), matching every rig
doc/quickstart; and `rig push`'s error when a refspec matches no local branch
now names the missing ref and your current branch (`no local branch or tag
"main" — your current branch is "master" (did you mean \`rig push origin
master\`?)`) instead of the misleading "ref deletion is out of scope" clause,
which is now reserved for actual `:ref` deletion syntax.
