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
 *
 * Everything else is `git <argv...>` verbatim: `rig status` runs git status.
 */

import { createInterface } from 'node:readline/promises';
import { dispatch } from './dispatch.js';
import type { CliIo } from './push.js';

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

dispatch(process.argv.slice(2), {
  io: makeIo(),
  env: process.env,
  cwd: process.cwd(),
}).then(
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
