---
'@toon-protocol/client-mcp': minor
---

Daemon `/git/*` routes + Publisher implementation + ControlClient methods (#227).

The daemon is now the paid transport for the Rig write path (epic #222):

- **Routes** (loopback control API): `POST /git/estimate` (plan + price a
  push without paying — serialized `PushPlan`, bigint fees as decimal
  strings), `POST /git/push` (requires `confirm: true`; uploads the object
  delta as kind:5094 store writes and publishes kind:30617/30618 — returns
  per-step receipts + total fees), and `POST /git/issue | /git/comment |
  /git/patch | /git/status` (kind:1621/1622/1617/1630-1633 paid publishes;
  `/git/patch` accepts literal `patchText` or `repoPath`+`range` and runs
  real `git format-patch`). planPush's structured errors surface as clean
  JSON: 409 `non_fast_forward` (with `refs`), 413 `oversize_objects` (with
  per-object sha/type/size/path), 400 `git_error` for plumbing failures.
- **Publisher impl** in `ClientRunner`: `getFeeRates` from the apex config
  (flat `feePerEvent` + the network per-byte upload rate), `uploadGitObject`
  as a Git-SHA/Git-Type/Repo-tagged kind:5094 store write signed with the
  daemon key and paid via `signBalanceProof` on the apex channel (Arweave
  txId decoded from the FULFILL HTTP envelope), `publishEvent` through the
  production paid publish path.
- **ControlClient**: matching typed `gitEstimate/gitPush/gitIssue/gitComment/
  gitPatch/gitStatus` methods (push gets a generous wire budget), and
  `ControlApiError` now carries structured error `data` (e.g. the rejected
  refs of a non-fast-forward).

The MCP tool surface (`toon_git_*`) lands separately in #230.
