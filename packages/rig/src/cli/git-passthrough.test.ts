/**
 * Git passthrough integration tests (#250): spawn the REAL `rig` bin
 * (src/cli/rig.ts via the workspace tsx) so the whole chain is exercised —
 * dispatch → spawn git with `stdio: 'inherit'` → exit-code propagation. The
 * child git inherits rig's stdio, which is a pipe to the test, so the output
 * asserted here is the literal git output a user would see.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RIG_TS = fileURLToPath(new URL('./rig.ts', import.meta.url));
// The workspace-root tsx (a rig devDependency would be circularly heavy; the
// monorepo root already ships it for the demo scripts).
const TSX_CLI = fileURLToPath(
  new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url)
);

const SUBPROCESS_TIMEOUT = 60_000;

interface RigRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real rig CLI; git output arrives on rig's (piped) stdio. */
function runRig(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<RigRun> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [TSX_CLI, RIG_TS, ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, LC_ALL: 'C', ...opts.env },
        timeout: SUBPROCESS_TIMEOUT,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error); // spawn failure / timeout, not a nonzero exit
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      }
    );
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test',
    },
  }).trim();
}

let repoDir: string;
let emptyDir: string;

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-rig-passthrough-'));
  git(['init', '--initial-branch=main'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# demo\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'first'], repoDir);
  emptyDir = mkdtempSync(join(tmpdir(), 'toon-rig-notarepo-'));
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe('rig → git passthrough (real subprocess)', () => {
  it(
    'rig status IS git status: real output, exit 0',
    async () => {
      const run = await runRig(['status'], { cwd: repoDir });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('On branch main');
      expect(run.stdout).toContain('nothing to commit');
      // No trace of the old NIP-34 status publish.
      expect(run.stderr).not.toContain('target-event-id');
    },
    SUBPROCESS_TIMEOUT
  );

  it(
    'propagates git exit 128 (status outside a repository)',
    async () => {
      const run = await runRig(['status'], { cwd: emptyDir });
      expect(run.code).toBe(128);
      expect(run.stderr).toContain('not a git repository');
    },
    SUBPROCESS_TIMEOUT
  );

  it(
    'propagates git exit 1 (grep without a match)',
    async () => {
      const run = await runRig(['grep', 'no-such-string-here'], {
        cwd: repoDir,
      });
      expect(run.code).toBe(1);
    },
    SUBPROCESS_TIMEOUT
  );

  it(
    'argv fidelity: format strings and embedded spaces survive verbatim',
    async () => {
      const sha = git(['rev-parse', 'HEAD'], repoDir);
      const formatted = await runRig(['log', '-1', '--pretty=format:%s|%H'], {
        cwd: repoDir,
      });
      expect(formatted.code).toBe(0);
      expect(formatted.stdout).toBe(`first|${sha}`);

      const spaced = await runRig(['log', '-1', '--pretty=format:hello world'], {
        cwd: repoDir,
      });
      expect(spaced.code).toBe(0);
      expect(spaced.stdout).toBe('hello world');
    },
    SUBPROCESS_TIMEOUT
  );

  it(
    'missing system git: clear error, exit 127',
    async () => {
      const run = await runRig(['status'], {
        cwd: repoDir,
        env: { PATH: join(emptyDir, 'no-bin-here') },
      });
      expect(run.code).toBe(127);
      expect(run.stderr).toContain('git not found');
      expect(run.stderr).toContain('rig status');
    },
    SUBPROCESS_TIMEOUT
  );

  it(
    '--version stays rig-owned',
    async () => {
      const run = await runRig(['--version'], { cwd: repoDir });
      const pkg = createRequire(import.meta.url)('../../package.json') as {
        version: string;
      };
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe(`rig ${pkg.version}`);
    },
    SUBPROCESS_TIMEOUT
  );
});
