#!/usr/bin/env node
/**
 * `rig` — the Git-to-TOON CLI shipped by `@toon-protocol/git` (epic #222).
 *
 * Subcommands:
 *   push               estimate → confirm → execute (#229, this file's v1)
 *   issue|comment|pr|status   arrive in toon-client#231 — the dispatch below
 *                      is the extension point (add a case + a runX command
 *                      module beside ./push.ts).
 */

import { createInterface } from 'node:readline/promises';
import { runPush, PUSH_USAGE, type CliIo, type PushDeps } from './push.js';

const USAGE = `rig — push git repos to TOON (pay-to-write Nostr + Arweave)

Usage: rig <command> [options]

Commands:
  push [refspecs...]   plan, price, confirm, and execute a paid push
                       (run \`rig push --help\` for flags)

Coming in toon-client#231: issue, comment, pr, status.`;

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
  const deps: PushDeps = {
    io,
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
  };

  switch (command) {
    case 'push':
      return runPush(rest, deps);
    case 'issue':
    case 'comment':
    case 'pr':
    case 'status':
      io.err(
        `rig ${command} is not implemented yet — it arrives with toon-client#231. ` +
          'In the meantime the toon-clientd daemon serves POST /git/' +
          `${command === 'pr' ? 'patch' : command} directly.`
      );
      return 1;
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
