// The gate, run DETERMINISTICALLY by the runner, not asked of the agent.
//
// `implement-prompt.md` tells the implementer to run the gate before it finishes, but that is
// advice the agent reports on itself. Verifying a build is plumbing, so the runner does it and
// never opens a PR while it is red.
//
// The steps are the ones in ci.yml's `build` job, in the same order. A gate that runs something
// merely similar to CI teaches the agent the wrong lesson. Two differences, both deliberate:
//
//   - CI runs lint and typecheck with `continue-on-error` and lets `gate-guard.ts` judge the
//     counts afterwards. Here they fail on their own exit code, so the fix session gets the
//     offending lines rather than a count. The baseline holds zero errors and zero typecheck
//     errors, so a non-zero exit is a violation either way. The guard still runs last, because
//     only it can see an ESLint *warning* creeping past the frozen count.
//   - The wall-clock and runner-minute checks are not passed to the guard: they time a whole
//     GitHub job, which this run is not.

import type * as sandcastle from '@ai-hero/sandcastle';

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

export interface GateStep {
  readonly name: string;
  readonly command: string;
}

export interface GateFailure {
  readonly step: string;
  readonly command: string;
  readonly exitCode: number;
  /** Tail of combined output: enough for an agent to act on, bounded so it cannot blow a prompt. */
  readonly output: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly ran: readonly string[];
  readonly failure: GateFailure | null;
}

/** Keep fed-back output useful but bounded. A full build log is large. */
const MAX_OUTPUT_CHARS = 12_000;

/**
 * ci.yml's `build` job, in order. `pnpm install --frozen-lockfile` is not a step: the sandbox's
 * `onSandboxReady` hook has already run it.
 */
export const GATE_STEPS: readonly GateStep[] = [
  {
    name: 'eslint',
    // The JSON report feeds the guard below. On a failure, print the readable form too.
    command:
      'npx eslint . -f json -o /tmp/eslint-report.json || { s=$?; npx eslint . --quiet; exit $s; }',
  },
  { name: 'build', command: 'pnpm -r build' },
  {
    name: 'typecheck',
    // `tee` would otherwise swallow tsc's exit code.
    command:
      "bash -o pipefail -c 'pnpm -r --no-bail run typecheck 2>&1 | tee /tmp/typecheck.log'",
  },
  { name: 'test', command: 'pnpm -r test --if-present' },
  // `pnpm -r` skips the workspace root, and the root vitest config is the only one that
  // covers `.sandcastle/` and `.github/rig-web-redirect/`.
  {
    name: 'root test',
    command: 'npx vitest run .sandcastle/ .github/rig-web-redirect/',
  },
  {
    name: 'gate guard',
    command:
      'npx tsx .sandcastle/gate-guard.ts --eslint-json=/tmp/eslint-report.json ' +
      '--typecheck-log=/tmp/typecheck.log',
  },
];

/**
 * Run `steps` in order, stopping at the first failure.
 *
 * Failure is returned, not thrown, so the caller can decide between a fix
 * iteration and failing the job.
 */
export async function runGate(sandbox: Sandbox, steps: readonly GateStep[]): Promise<GateResult> {
  const ran: string[] = [];

  for (const step of steps) {
    console.log(`  [gate] ${step.name}: ${step.command}`);
    const lines: string[] = [];
    const result = await sandbox.exec(step.command, {
      onLine: (line) => {
        lines.push(line);
        // Stream sparingly: full build output would bury the runner log.
        if (lines.length <= 40) console.log(`    | ${line}`);
      },
    });
    ran.push(step.name);

    if (result.exitCode !== 0) {
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const output =
        combined.length > MAX_OUTPUT_CHARS
          ? `...(truncated to the last ${MAX_OUTPUT_CHARS} chars)...\n` +
            combined.slice(-MAX_OUTPUT_CHARS)
          : combined;

      console.log(`  [gate] FAILED at ${step.name} (exit ${result.exitCode}).`);
      return {
        passed: false,
        ran,
        failure: { step: step.name, command: step.command, exitCode: result.exitCode, output },
      };
    }
  }

  console.log(`  [gate] PASSED (${ran.length} step(s): ${ran.join(', ') || 'none applicable'}).`);
  return { passed: true, ran, failure: null };
}

/** The prompt handed to a fix iteration. Concrete failure, no room to reinterpret the task. */
export function fixPrompt(failure: GateFailure, attempt: number, maxAttempts: number): string {
  return [
    `The repository gate is RED. This is fix attempt ${attempt} of ${maxAttempts}.`,
    '',
    `Failing step: ${failure.step}`,
    `Command:      ${failure.command}`,
    `Exit code:    ${failure.exitCode}`,
    '',
    'Output:',
    '```',
    failure.output,
    '```',
    '',
    'Fix the cause and commit. Rules:',
    `- Re-run \`${failure.command}\` yourself and confirm it passes before you finish.` +
      (failure.step === 'gate guard'
        ? ' It reads the reports the eslint and typecheck steps write, so re-run those first.'
        : ''),
    '- Fix the code. Do NOT weaken, skip, delete or ignore a test, and do not',
    '  loosen a lint to make this pass — if the test is genuinely wrong, say so',
    '  explicitly in the commit message and explain why.',
    '- Change only what this failure requires. Do not refactor beyond it.',
    '- If you cannot fix it, commit nothing and explain what is blocking you.',
  ].join('\n');
}
