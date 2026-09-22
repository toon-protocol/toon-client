/**
 * The `toon` command, run the way a shell runs it: through the symlink npm
 * makes for `bin`.
 *
 * This is the integration tier because it spawns a process, and it spawns a
 * process because the defect it pins (#640) does not exist anywhere smaller.
 * `isEntryPoint`'s own cases in `src/cli/main.test.ts` prove the comparison;
 * only an actual invocation proves the comparison is still WIRED to the run —
 * that `runCli` is reached, and that the command speaks. `node_modules/.bin/toon`
 * exited 0 having printed nothing, and silence with a zero status is the shape
 * of this bug: a script that branches on `$?` sees green either way.
 *
 * It runs the TypeScript entry under `tsx` rather than `dist/`, which is what
 * lets this job stay build-free like the other suites here — the entry check
 * being tested is the same source either way.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageVersion } from '../cli/main.js';

const run = promisify(execFile);

/** tsx's own entry, resolved through its exports rather than guessed at. */
const TSX = createRequire(import.meta.url).resolve('tsx/cli');

/** The CLI entry, by its real path — the target every link below points at. */
const ENTRY = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'toon-bin-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Invoke the entry through `link`, and hand back everything it said. */
async function toon(link: string, ...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [TSX, link, ...args]);
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? '', code: failure.code ?? 1 };
  }
}

describe('the toon command through its bin symlink', () => {
  it('answers --version, rather than exiting 0 in silence', async () => {
    const link = join(dir, 'toon');
    symlinkSync(ENTRY, link);

    const { stdout, code } = await toon(link, '--version');

    // stdout FIRST, and it is the assertion that matters: the broken build
    // exited 0 too, so a check on the status alone passes on it.
    expect(stdout.trim()).not.toBe('');
    expect(stdout.trim()).toBe(packageVersion());
    expect(code).toBe(0);
  });

  it('prints its usage through a link with no arguments at all', async () => {
    const link = join(dir, 'toon-usage');
    symlinkSync(ENTRY, link);

    const { stdout } = await toon(link);

    expect(stdout).toContain('toon');
    expect(stdout.trim()).not.toBe('');
  });

  it('still answers when the link is reached through a second link', async () => {
    // npm's global installs stack them: a bin shim in one prefix pointing at a
    // package directory that is itself a link. One `realpath` collapses both.
    const first = join(dir, 'toon-inner');
    const second = join(dir, 'toon-outer');
    symlinkSync(ENTRY, first);
    symlinkSync(first, second);

    const { stdout } = await toon(second, '--version');

    expect(stdout.trim()).toBe(packageVersion());
  });
});
