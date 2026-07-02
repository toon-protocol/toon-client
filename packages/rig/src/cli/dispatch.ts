/**
 * `rig` subcommand dispatch (#250): rig-owned verbs first, git for the rest.
 *
 * rig owns exactly: init, remote, clone, fetch, push, issue, comment, pr,
 * channel, fund, balance, help/-h/--help, and --version. EVERY other
 * subcommand is executed as `git <argv...>` verbatim (./git-passthrough.ts)
 * — `rig status` IS `git status`, `rig add -p`, `rig commit`, `rig rebase
 * -i`, … all land in git with rig's stdio and git's exit code. Owned verbs
 * always win: `rig push` is the paid TOON push and shadows `git push`, and
 * `rig clone`/`rig fetch` (#278) are the free TOON transports shadowing
 * their git counterparts (plain-git clone/fetch/push stay available by
 * calling git directly).
 *
 * The NIP-34 status publish that used to be `rig status` lives at
 * `rig pr status` since #250 (BREAKING) — bare `rig status` is git's.
 *
 * `--json` (#265) follows the same ownership boundary: it is a flag OF the
 * owned subcommands, never a global rig flag. `rig --json status` starts
 * with a verb rig does not own (`--json`), so the WHOLE argv passes through
 * to git verbatim — rig neither consumes the flag nor applies the strict
 * stdout contract to git's inherited stdio. The owned-verb list is pinned to
 * ./output.ts's RIG_OWNED_VERBS (strict-json.test.ts keeps them in sync).
 */

import { createRequire } from 'node:module';
import { runBalance } from './balance.js';
import { runChannel } from './channel.js';
import { runClone } from './clone.js';
import { runComment, runIssue, runPr, type EventCommandDeps } from './events.js';
import { runFetch } from './fetch.js';
import { runFund } from './fund.js';
import { runGitPassthrough, type GitRunner } from './git-passthrough.js';
import { runInit } from './init.js';
import { runPush, PUSH_USAGE } from './push.js';
import { runRemote } from './remote.js';

export const USAGE = `rig — git with a TOON remote (pay-to-write Nostr + Arweave)

Usage: rig <command> [options]

Commands rig owns:
  init                       set up this repo: resolve your identity
                             (RIG_MNEMONIC) and write the toon.* git config
  remote add <name> <url>    add a relay as a REAL git remote ("origin" is
  remote remove <name>       the default publish target); remove/list manage
  remote list                them — \`git remote -v\` shows the same data
  clone <relay-url> <owner>/<repo-id> [dir]
                             clone a TOON repo (free): relay state + Arweave
                             objects (SHA-1 verified) → a real git repository,
                             push/pull-capable out of the box
  fetch [remote]             fetch remote refs + missing objects (free) and
                             update refs/remotes/<remote>/*; no merge. Shadows
                             git fetch (plain \`git fetch\` stays available)
  push [remote] [refspecs...]  plan, price, confirm, and execute a paid push
                             to TOON (defaults to the "origin" remote). rig
                             push is the TOON transport and shadows git push;
                             plain-git pushes remain available by running
                             \`git push\` directly
  issue create               file an issue (kind:1621) against a repo
  issue list | show <id>     read the repo's issues + comments (free)
  pr list | show <id>        read the repo's patches; show prints the full
                             patch text (free)
  comment <root-event-id>    comment (kind:1622) on an issue or patch
  pr create                  publish a patch (kind:1617) with real
                             \`git format-patch\` content
  pr status <event-id> <state>  set an issue/patch status (kind:1630-1633):
                             open | applied | closed | draft
  fund                       drip devnet faucet funds to this identity's
                             wallet (free); on other networks prints the
                             address(es) to fund externally
  balance                    wallet balances + payment-channel holdings
                             (free — chain reads and local state only)
  channel list               show the payment channels paid commands hold
                             (free — reads local state)
  channel open               explicitly open (or resume) the channel for a
                             peer; --deposit adds collateral (on-chain)
  channel close <channelId>  start the settlement challenge window (on-chain)
  channel settle <channelId> release collateral after the window (on-chain)

Any other command is passed through to git verbatim: \`rig status\` runs
\`git status\`, and \`rig add -p\`, \`rig commit\`, \`rig log --oneline\`,
\`rig rebase -i\`, … behave exactly like git (same output, same exit code).

Run \`rig <command> --help\` for a rig command's flags. \`rig init\`,
\`rig remote\`, \`rig clone\`, \`rig fetch\`, \`rig issue list/show\`,
\`rig pr list/show\`, \`rig fund\`, \`rig balance\`, and \`rig channel list\`
are free; push/issue create/comment/pr create/pr status are paid writes —
permanent and non-refundable —
and channel open/close/settle are on-chain wallet transactions; each states
what it will spend and asks for confirmation before doing so (--yes skips,
--json emits machine output).

With --json, stdout carries exactly ONE JSON document (everything human-facing
goes to stderr), so \`rig <command> --json | jq\` always parses. --json is a
per-subcommand flag on the commands rig owns, NOT a global rig flag: it does
not apply to the git passthrough (\`rig status --json\` runs
\`git status --json\`), and flags placed before the subcommand
(\`rig --json status\`) pass through to git untouched.`;

/** Dispatch deps: the event-command deps plus an injectable git runner. */
export interface DispatchDeps extends EventCommandDeps {
  /** Runs the git passthrough (default: real spawned git; tests inject). */
  runGit?: GitRunner;
}

/**
 * Version of the @toon-protocol/rig package this CLI shipped in. Resolved at
 * runtime relative to this module, which tsup may emit either as the
 * dist/cli/rig.js entry or a dist/ chunk — hence the short upward walk.
 */
export function rigVersion(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ['../package.json', '../../package.json', '../../../package.json']) {
    try {
      const pkg = require(rel) as { name?: string; version?: string };
      if (pkg.name === '@toon-protocol/rig' && pkg.version) return pkg.version;
    } catch {
      // keep walking up
    }
  }
  return 'unknown';
}

/** Route one rig invocation (argv WITHOUT node/script); returns the exit code. */
export async function dispatch(
  argv: string[],
  deps: DispatchDeps
): Promise<number> {
  const [command, ...rest] = argv;
  const { io } = deps;

  switch (command) {
    case 'init':
      return runInit(rest, deps);
    case 'remote':
      return runRemote(rest, deps);
    // The #278 read path — FREE (relay + Arweave gateway reads, no payment).
    case 'clone':
      return runClone(rest, deps);
    case 'fetch':
      return runFetch(rest, deps);
    case 'push':
      return runPush(rest, deps);
    case 'issue':
      return runIssue(rest, deps);
    case 'comment':
      return runComment(rest, deps);
    case 'pr':
      return runPr(rest, deps);
    case 'channel':
      return runChannel(rest, deps);
    case 'fund':
      return runFund(rest, deps);
    case 'balance':
      return runBalance(rest, deps);
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      io.out('');
      io.out(PUSH_USAGE);
      return 0;
    case '--version':
      io.out(`rig ${rigVersion()}`);
      return 0;
    case undefined:
      io.err(USAGE);
      return 2;
    default:
      // Git passthrough (#250): rig does not own this verb, so the EXACT
      // argv tail goes to system git — flags, quoting, and exit code intact.
      return (deps.runGit ?? runGitPassthrough)(argv, {
        cwd: deps.cwd,
        env: deps.env,
        err: (line) => io.err(line),
      });
  }
}
