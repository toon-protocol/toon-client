// Single-PR review runner — the entry point the `agent:review` label→runner
// workflow (.github/workflows/agent-review.yml) invokes when `agent:review` is
// applied to ONE pull request.
//
// This is the single-pass replacement for the old 4-round `review-round:*`
// pr-reviewer loop. It runs the reviewer role (review-prompt.md — refactor for
// clarity while preserving behavior, enforce CODING_STANDARDS.md) against the
// PR's head branch, and pushes any refinement commits back to the PR. It NEVER
// merges the PR and NEVER closes anything — a human still merges.
//
// COEXISTS WITH THE OLD pr-reviewer LOOP, which fires on `review-round:*`
// (disjoint labels), so a PR triggers exactly one reviewer engine. Retiring the
// old loops in toon-client is a separate, gated slice taken only after this repo
// merges a real agent PR through the new runners.
//
// STANDALONE-REVIEW CAVEAT (verify on first run)
// ----------------------------------------------
// Sandcastle 0.12.0 exercises the reviewer only INSIDE the parallel loop's
// Phase 2, on a fresh `sandcastle/issue-*` branch it just created. Driving the
// same reviewer standalone against an already-existing PR head branch is our
// interpretation, not a documented engine feature. Two things to confirm on the
// first live run:
//   1. createSandbox({ branch: <existing PR head> }) checks out the EXISTING
//      branch (rather than failing because the ref already exists / creating a
//      divergent one). The workflow checks out the PR head first to help this.
//   2. The built-in {{TARGET_BRANCH}} inside review-prompt.md resolves to `main`
//      for a standalone sandbox. If the diff comes back empty, the base may be
//      resolving wrong — check the reviewer's logged `git diff` command.
//
// Required env:
//   SANDCASTLE_PR_NUMBER      the PR to review (github.event.pull_request.number)
//   CLAUDE_CODE_OAUTH_TOKEN   Claude Max-plan credential (org secret)
//   GH_TOKEN                  token with contents:write + pull-requests:write
//
// Usage:
//   SANDCASTLE_PR_NUMBER=42 npx tsx .sandcastle/agent-review-pr.ts
//   # or: pnpm sandcastle:review   (with SANDCASTLE_PR_NUMBER exported)

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxSecrets } from "./sandbox-secrets.ts";

const prNumber = process.env.SANDCASTLE_PR_NUMBER?.trim();
if (!prNumber || !/^\d+$/.test(prNumber)) {
  throw new Error(
    "SANDCASTLE_PR_NUMBER must be set to a numeric PR number " +
      `(got: ${JSON.stringify(process.env.SANDCASTLE_PR_NUMBER)}).`,
  );
}

// Resolve the PR's head branch on the host. `gh` authenticates via GH_TOKEN.
const headRef = execFileSync(
  "gh",
  ["pr", "view", prNumber, "--json", "headRefName", "--jq", ".headRefName"],
  { encoding: "utf8" },
).trim();

if (!headRef) {
  throw new Error(`Could not resolve head branch for PR #${prNumber}.`);
}

// toon-client is a large pnpm monorepo. `packageManager` matches the committed
// lockfileVersion 9 (pnpm@9.12.3, toon-client#425), so we install frozen,
// mirroring main.ts and ci.yml. We do NOT copyToWorktree node_modules (pnpm's
// symlinked store breaks across the bind-mount).
const hooks = {
  sandbox: {
    onSandboxReady: [
      // Wire `git push` auth deterministically inside the container, as the
      // FIRST hook. @ai-hero/sandcastle@0.12.0 does NO credential setup, so the
      // review-push step's in-sandbox `git push` to the PR branch is otherwise
      // unauthenticated and only succeeds by luck (store#50 root cause; fixed
      // in store#51, validated by store#52). `gh auth setup-git` installs `gh`
      // as git's credential helper (reads GH_TOKEN at push time, stores no
      // token in any file). Guarded on GH_TOKEN so token-less local dev no-ops.
      {
        command:
          'if [ -n "$GH_TOKEN" ]; then gh auth setup-git; ' +
          "git config --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true; fi",
      },
      { command: "pnpm install --frozen-lockfile" },
    ],
  },
};

console.log(
  `\n=== agent:review runner — PR #${prNumber} (head: ${headRef}) ===\n`,
);

// Set to a non-null message in the push-verification step below when the
// push-review phase reported success but the reviewer's commits never landed on
// the remote PR branch. Recorded here (rather than exiting inside the try) so
// the `finally` still closes the sandbox before we fail the job non-zero.
let reviewPushVerificationError: string | null = null;

const sandbox = await sandcastle.createSandbox({
  branch: headRef,
  // Forward CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN into the container (the engine's
  // env resolver does not — see ./sandbox-secrets.ts). GH_TOKEN is what the
  // review-push step's in-sandbox `git push` to the PR branch authenticates with.
  sandbox: docker({ env: sandboxSecrets() }),
  hooks,
});

try {
  const review = await sandbox.run({
    name: "reviewer",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-sonnet-5"),
    promptFile: "./.sandcastle/review-prompt.md",
    promptArgs: { BRANCH: headRef },
  });

  if (review.commits.length > 0) {
    // Push the reviewer's refinement commits back onto the PR branch. No merge,
    // no close, no new PR — the existing PR just gets updated.
    console.log(
      `\nReviewer made ${review.commits.length} commit(s) — pushing to the PR branch.`,
    );
    // DETERMINISTIC (no agent) — see toon-meta#235. This was an agent run
    // (review-push-prompt.md) whose only job was `git push origin <branch>`.
    // Run it directly; sandbox.exec() surfaces a non-zero exitCode (it does NOT
    // throw) — check it and fail loud.
    const push = await sandbox.exec(`git push origin ${headRef}`, {
      onLine: (line) => console.log(`  [push] ${line}`),
    });
    if (push.exitCode !== 0) {
      throw new Error(
        `git push of '${headRef}' failed (exit ${push.exitCode}).\n${push.stderr}`,
      );
    }

    // FAIL LOUD. The push-review phase logs COMPLETE from the prompt regardless
    // of whether the in-sandbox `git push` actually landed, so we must NOT trust
    // it (same silent-push failure class as store#50). Verify from the HOST
    // (whose `gh` is authenticated via GH_TOKEN) that the reviewer's LAST commit
    // now exists on the remote. If it does not, the push failed silently — dump
    // state and exit non-zero so the Actions job FAILS instead of green-lying.
    const lastReviewSha = review.commits[review.commits.length - 1]!.sha;
    const nwo = execFileSync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { encoding: "utf8" },
    ).trim();

    let commitPushed = false;
    try {
      execFileSync("gh", ["api", `repos/${nwo}/commits/${lastReviewSha}`], {
        stdio: "pipe",
      });
      commitPushed = true;
    } catch {
      commitPushed = false;
    }

    if (commitPushed) {
      console.log(
        `\nVerified: reviewer commit ${lastReviewSha.slice(0, 12)} is on the ` +
          `remote PR branch '${headRef}'.`,
      );
    } else {
      reviewPushVerificationError =
        `\nERROR: the push-review phase reported COMPLETE, but the reviewer's ` +
        `last commit ${lastReviewSha} is NOT on the remote for branch ` +
        `'${headRef}'.\n` +
        `  The in-sandbox \`git push\` failed silently. Inspect the ` +
        `push-review phase logs above. The Actions job is failing deliberately ` +
        `so this is not mistaken for success.`;
    }
  } else {
    console.log(
      "\nReviewer made no changes — the code was already clean. Nothing to push.",
    );
  }
} finally {
  await sandbox.close();
}

// Fail loud AFTER the sandbox is closed: a silently-failed push must turn the
// Actions job red, never green.
if (reviewPushVerificationError) {
  console.error(reviewPushVerificationError);
  process.exit(1);
}

console.log("\nReview complete. The PR was NOT merged — a human still merges.");
