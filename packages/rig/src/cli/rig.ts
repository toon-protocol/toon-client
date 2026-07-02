#!/usr/bin/env node
/**
 * `rig` — the Git-to-TOON CLI shipped by `@toon-protocol/rig` (epic #222;
 * standalone-only since #248).
 *
 * Subcommands:
 *   init                        one-shot repo setup (identity + toon.* git config)
 *   push                        estimate → confirm → execute (#229)
 *   issue | comment | pr | status   single NIP-34 event publishes (#231)
 */

import { createInterface } from 'node:readline/promises';
import {
  runComment,
  runIssue,
  runPr,
  runStatus,
  type EventCommandDeps,
} from './events.js';
import { runInit } from './init.js';
import { runPush, PUSH_USAGE, type CliIo } from './push.js';

const USAGE = `rig — push git repos to TOON (pay-to-write Nostr + Arweave)

Usage: rig <command> [options]

Commands:
  init                       set up this repo: resolve your identity
                             (RIG_MNEMONIC) and write the toon.* git config
  push [refspecs...]         plan, price, confirm, and execute a paid push
  issue create               file an issue (kind:1621) against a repo
  comment <root-event-id>    comment (kind:1622) on an issue or patch
  pr create                  publish a patch (kind:1617) with real
                             \`git format-patch\` content
  status <event-id> <state>  set an issue/patch status (kind:1630-1633):
                             open | applied | closed | draft

Run \`rig <command> --help\` for the command's flags. \`rig init\` is free;
all other commands are paid writes — permanent and non-refundable; each
quotes its fee and asks for confirmation before spending (--yes skips,
--json emits machine output).`;

/** Real terminal I/O: stdout lines, stderr lines, readline y/N confirm. */
function makeIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = (await rl.question(question)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const io = makeIo();
  const deps: EventCommandDeps = {
    io,
    env: process.env,
    cwd: process.cwd(),
  };

  switch (command) {
    case 'init':
      return runInit(rest, deps);
    case 'push':
      return runPush(rest, deps);
    case 'issue':
      return runIssue(rest, deps);
    case 'comment':
      return runComment(rest, deps);
    case 'pr':
      return runPr(rest, deps);
    case 'status':
      return runStatus(rest, deps);
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      io.out('');
      io.out(PUSH_USAGE);
      return 0;
    case undefined:
      io.err(USAGE);
      return 2;
    default:
      io.err(`unknown command: ${command}`);
      io.err(USAGE);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `rig: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exitCode = 1;
  }
);
