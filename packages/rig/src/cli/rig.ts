#!/usr/bin/env node
/**
 * `rig` — the git-native TOON CLI shipped by `@toon-protocol/rig` (epic
 * #222; standalone-only since #248; git passthrough since #250).
 *
 * rig-owned subcommands (see ./dispatch.ts):
 *   init                        one-shot repo setup (identity + toon.* git config)
 *   remote                      relays as git remotes (#249): add/remove/list
 *   push                        estimate → confirm → execute (#229)
 *   issue | comment | pr        single NIP-34 event publishes (#231), incl.
 *                               `pr status` (moved from `rig status` in #250)
 *   channel                     payment channels (#262/#263): list, open,
 *                               close, settle
 *   fund | balance              client money lifecycle (#263): devnet faucet
 *                               drip; wallet + channel balances
 *
 * Everything else is `git <argv...>` verbatim: `rig status` runs git status.
 *
 * STRICT `--json` STDOUT (#265): when a rig-owned command runs with `--json`,
 * stdout carries exactly one JSON document — the process-level stdout guard
 * reroutes every other write (including dependencies' `console.log`) to
 * stderr, the io layer sends human lines to stderr, and the post-dispatch
 * backstop emits an error envelope for paths that bailed before emitting.
 * The git passthrough is exempt: it inherits stdio verbatim (./output.ts).
 * The enforcement matrix in ./strict-json.test.ts mirrors this composition.
 */

import { createInterface } from 'node:readline/promises';
import { dispatch } from './dispatch.js';
import {
  calmBootstrapNoise,
  isJsonInvocation,
  makeCliIo,
  redirectStdoutToStderr,
  type RigIo,
} from './output.js';

/** Real terminal I/O: stdout/stderr sinks + readline y/N confirm. */
function makeIo(jsonMode: boolean): RigIo {
  // Reframe the embedded client's expected announce-402 stderr noise (#280)
  // — installed for every mode, before any command code can run.
  calmBootstrapNoise();
  // In --json mode, patch process.stdout FIRST — before any command (or its
  // dynamically imported dependencies) can write — and keep the only real
  // stdout writer for the machine document.
  const guard = jsonMode ? redirectStdoutToStderr() : undefined;
  return makeCliIo({
    jsonMode,
    writeStdout: guard
      ? guard.write
      : (text) => {
          process.stdout.write(text);
        },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
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
  });
}

/**
 * Exit as soon as stdio is flushed (#279). By the time dispatch resolves,
 * every command has finished its work and awaited its teardown — but the
 * embedded `@toon-protocol/client` can leave a keep-alive socket behind
 * that holds the Node event loop open for ~30 more seconds. That lingering
 * handle — not discovery or negotiation — was the bulk of the uniform
 * "~32s per paid command" tax the #279 study measured. Nothing rig can
 * reach unrefs it, so the one-shot CLI does what one-shot CLIs do: flush
 * and exit.
 */
function exitWhenFlushed(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

const argv = process.argv.slice(2);
const io = makeIo(isJsonInvocation(argv));

dispatch(argv, {
  io,
  env: process.env,
  cwd: process.cwd(),
}).then(
  (code) => {
    io.ensureSingleJsonDoc(code);
    exitWhenFlushed(code);
  },
  (err: unknown) => {
    process.stderr.write(
      `rig: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    io.ensureSingleJsonDoc(1);
    exitWhenFlushed(1);
  }
);
