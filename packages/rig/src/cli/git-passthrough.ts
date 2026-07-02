/**
 * Git passthrough (#250): any subcommand `rig` does not own is executed as
 * `git <argv...>` verbatim — `rig status`, `rig add -p`, `rig commit`,
 * `rig log --oneline`, `rig rebase -i`, everything.
 *
 * The child git runs with `stdio: 'inherit'` so interactive commands, pagers,
 * colors, and prompts behave exactly as if the user had typed `git` (no
 * capture, no buffering). The child's exit code is propagated verbatim; a
 * child killed by a signal maps to the shell convention 128+N. While the
 * child runs, rig ignores-and-forwards SIGINT/SIGTERM/SIGHUP so git (not
 * rig) decides the outcome of a Ctrl-C — e.g. `rebase -i` gets to clean up —
 * and rig then reports git's exit.
 */

import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

export interface GitPassthroughOptions {
  /** Working directory for the git child (default: the rig process cwd). */
  cwd?: string;
  /** Environment for the git child (default: the rig process env). */
  env?: NodeJS.ProcessEnv;
  /** Write one line to stderr (missing-git error); default: process.stderr. */
  err?: (line: string) => void;
}

/** The passthrough seam `dispatch` uses; tests inject a fake. */
export type GitRunner = (
  argv: string[],
  options?: GitPassthroughOptions
) => Promise<number>;

/** Exit code when the system git binary cannot be found (shell convention). */
export const GIT_NOT_FOUND_EXIT = 127;

/** Signals relayed to the git child while it runs. */
const RELAYED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Shell-convention exit code for a child terminated by `signal`. */
function signalExitCode(signal: NodeJS.Signals): number {
  const num = osConstants.signals[signal];
  return num === undefined ? 1 : 128 + num;
}

/**
 * Run system `git` with the exact argv tail, inheriting rig's stdio.
 * Resolves to the exit code rig should exit with; never rejects.
 */
export const runGitPassthrough: GitRunner = (argv, options = {}) => {
  const err =
    options.err ?? ((line: string) => process.stderr.write(`${line}\n`));

  return new Promise<number>((resolve) => {
    const child = spawn('git', argv, {
      stdio: 'inherit',
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
    });

    // Terminal-generated signals (Ctrl-C) already reach the child through the
    // shared foreground process group; the handlers stop rig's default
    // die-on-signal so the child controls the outcome, and forward the signal
    // for the cases where only rig was targeted (`kill <rig-pid>`).
    const relay = new Map<NodeJS.Signals, () => void>();
    for (const signal of RELAYED_SIGNALS) {
      const handler = (): void => {
        child.kill(signal);
      };
      relay.set(signal, handler);
      process.on(signal, handler);
    }
    const restoreSignals = (): void => {
      for (const [signal, handler] of relay) process.removeListener(signal, handler);
    };

    child.on('error', (spawnErr: NodeJS.ErrnoException) => {
      restoreSignals();
      if (spawnErr.code === 'ENOENT') {
        err(
          `rig: git not found — \`rig ${argv[0] ?? ''}\` is not a rig command, so it is ` +
            'passed through to the system `git`, which is not on your PATH. ' +
            'Install git (https://git-scm.com) or fix your PATH.'
        );
        resolve(GIT_NOT_FOUND_EXIT);
        return;
      }
      err(`rig: failed to run git: ${spawnErr.message}`);
      resolve(1);
    });

    child.on('close', (code, signal) => {
      restoreSignals();
      resolve(signal !== null ? signalExitCode(signal) : (code ?? 1));
    });
  });
};
