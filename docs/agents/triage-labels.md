# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## The AFK factory

`ready-for-agent` is also the factory's queue. `.github/workflows/agent-implement.yml` runs when
the label is applied, when any issue closes, every two hours and on dispatch, and starts an
issue only when it is not a spec (no sub-issues, no `## User Stories` section), has no open
blocker (GitHub's native "blocked by", or an issue listed under a `## Blocked by` heading) and
has no open PR on `sandcastle/issue-N`.

For each such issue the runner (`.sandcastle/agent-implement-issue.ts`) runs
`/mattpocock-skills:implement`, then `/mattpocock-skills:code-review` in a second session, then
the commands of `ci.yml`'s `build` job itself, with at most two fix passes. It never opens a PR
while that gate is red.

| Outcome | Issue                                                   | PR                                                                         |
| ------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Success | loses `ready-for-agent`                                 | opened with `Closes #N` and the review summary, labelled `ready-for-human` |
| Failure | moves to `needs-triage`, with a comment linking the run | none. Any work is on `sandcastle/issue-N`                                  |

Put `ready-for-agent` back on the issue to retry. A human merges. No other label drives any
workflow, and no workflow here applies `agent:*`, `needs:human` or `tracking`.
