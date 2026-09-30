import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_STEPS, fixPrompt } from './run-gate.ts';

// The runner's gate must be CI's `build` job, in order. If ci.yml moves and this file does not, the
// runner starts opening PRs that CI then rejects, or refusing ones CI would take.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');

/** The text of the `build` job: from `  build:` to the next top-level job. */
function buildJob(): string {
  const start = ci.indexOf('\n  build:\n');
  expect(start, 'ci.yml has no `build` job').toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z][\w-]*:\n/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('GATE_STEPS', () => {
  it('runs the commands of ci.yml build job, in the same order', () => {
    const job = buildJob();
    const needles = [
      'npx eslint . -f json -o /tmp/eslint-report.json',
      'pnpm -r build',
      'pnpm -r --no-bail run typecheck',
      'pnpm -r test --if-present',
      'npx vitest run .sandcastle/ .github/rig-web-redirect/',
      'npx tsx .sandcastle/gate-guard.ts',
    ];
    const positions = needles.map((n) => job.indexOf(n));
    expect(positions.every((p) => p >= 0), `missing from ci.yml build job: ${needles.filter((_, i) => positions[i]! < 0)}`).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(GATE_STEPS).toHaveLength(needles.length);
    needles.forEach((needle, i) => expect(GATE_STEPS[i]!.command).toContain(needle));
  });

  it('gives the guard the reports the lint and typecheck steps write', () => {
    const guard = GATE_STEPS.at(-1)!.command;
    const lint = GATE_STEPS[0]!.command;
    const typecheck = GATE_STEPS[2]!.command;
    expect(lint).toContain('/tmp/eslint-report.json');
    expect(typecheck).toContain('/tmp/typecheck.log');
    expect(guard).toContain('--eslint-json=/tmp/eslint-report.json');
    expect(guard).toContain('--typecheck-log=/tmp/typecheck.log');
  });

  it('does not let a piped typecheck hide its own exit code', () => {
    expect(GATE_STEPS[2]!.command).toContain('pipefail');
  });
});

describe('fixPrompt', () => {
  it('names the failing step and forbids weakening a test', () => {
    const prompt = fixPrompt(
      { step: 'build', command: 'pnpm -r build', exitCode: 2, output: 'boom' },
      1,
      2
    );
    expect(prompt).toContain('fix attempt 1 of 2');
    expect(prompt).toContain('pnpm -r build');
    expect(prompt).toContain('boom');
    expect(prompt).toMatch(/Do NOT weaken, skip, delete or ignore a test/);
  });
});
