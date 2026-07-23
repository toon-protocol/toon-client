// Compares live gate measurements against the frozen `.sandcastle/gate-baseline.json`
// and fails (non-zero exit) on any NEW violation — closing the no-false-PASS holes
// described in toon-client#433 / toon-meta#210 (ADR-0001, baseline-freeze first).
//
// Usage (wired into ci.yml's build job):
//   node --experimental-strip-types .sandcastle/gate-guard.ts \
//     --eslint-json=/tmp/eslint.json \
//     --typecheck-log=/tmp/typecheck.log \
//     --wall-clock-seconds=$WALL_CLOCK \
//     --runner-minutes=$RUNNER_MINUTES

import { readFileSync } from 'node:fs';

export type EslintCounts = { errors: number; warnings: number };

export type TypecheckCounts = { totalErrors: number; byPackage: Record<string, number> };

export type CorrectnessBaseline = { eslint: EslintCounts; typecheck: TypecheckCounts };

export type SpeedBaseline = { gateWallClockSeconds: number | null };

export type PerformanceBaseline = {
  runnerMinutesEstimate: number | null;
  imageSizeBytes: number | null;
};

export type GateBaseline = {
  tolerancePercent: number;
  correctness: CorrectnessBaseline;
  speed: SpeedBaseline;
  performance: PerformanceBaseline;
};

export type LiveCorrectness = { eslint: EslintCounts; typecheck: TypecheckCounts };

export type LiveSpeedPerformance = {
  gateWallClockSeconds?: number;
  runnerMinutes?: number;
  imageSizeBytes?: number;
};

export type Verdict = { ok: boolean; violations: string[] };

export function parseEslintJson(json: string): EslintCounts {
  const files = JSON.parse(json) as Array<{ errorCount: number; warningCount: number }>;
  return files.reduce(
    (acc, f) => ({ errors: acc.errors + f.errorCount, warnings: acc.warnings + f.warningCount }),
    { errors: 0, warnings: 0 },
  );
}

export function parseTypecheckOutput(text: string, packages: string[]): TypecheckCounts {
  const byPackage: Record<string, number> = Object.fromEntries(packages.map((p) => [p, 0]));
  for (const line of text.split('\n')) {
    const match = /^packages\/(\S+) typecheck: .*error TS\d+/.exec(line);
    if (match && match[1] !== undefined && match[1] in byPackage) {
      byPackage[match[1]] = (byPackage[match[1]] ?? 0) + 1;
    }
  }
  const totalErrors = Object.values(byPackage).reduce((a, b) => a + b, 0);
  return { totalErrors, byPackage };
}

export function evaluateCorrectness(live: LiveCorrectness, baseline: CorrectnessBaseline): Verdict {
  const violations: string[] = [];

  if (live.eslint.errors > baseline.eslint.errors) {
    violations.push(`eslint errors regressed: ${live.eslint.errors} > frozen baseline ${baseline.eslint.errors}`);
  }
  if (live.eslint.warnings > baseline.eslint.warnings) {
    violations.push(`eslint warnings regressed: ${live.eslint.warnings} > frozen baseline ${baseline.eslint.warnings}`);
  }
  if (live.typecheck.totalErrors > baseline.typecheck.totalErrors) {
    violations.push(
      `typecheck errors regressed: ${live.typecheck.totalErrors} > frozen baseline ${baseline.typecheck.totalErrors}`,
    );
  }

  const packages = new Set([...Object.keys(baseline.typecheck.byPackage), ...Object.keys(live.typecheck.byPackage)]);
  for (const pkg of packages) {
    const baselineCount = baseline.typecheck.byPackage[pkg] ?? 0;
    const liveCount = live.typecheck.byPackage[pkg] ?? 0;
    if (liveCount > baselineCount) {
      violations.push(`typecheck errors regressed in packages/${pkg}: ${liveCount} > frozen baseline ${baselineCount}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

function checkTolerance(
  label: string,
  live: number | undefined,
  baseline: number | null,
  tolerancePercent: number,
): string | null {
  if (baseline === null || live === undefined) return null;
  const threshold = baseline * (1 + tolerancePercent / 100);
  if (live > threshold) {
    return `${label} regressed: ${live} > frozen baseline ${baseline} + ${tolerancePercent}% tolerance (${threshold.toFixed(2)})`;
  }
  return null;
}

export function evaluateSpeedPerformance(
  live: LiveSpeedPerformance,
  speedBaseline: SpeedBaseline,
  performanceBaseline: PerformanceBaseline,
  tolerancePercent: number,
): Verdict {
  const violations = [
    checkTolerance('gate wall-clock', live.gateWallClockSeconds, speedBaseline.gateWallClockSeconds, tolerancePercent),
    checkTolerance('runner-minutes', live.runnerMinutes, performanceBaseline.runnerMinutesEstimate, tolerancePercent),
    checkTolerance('image size', live.imageSizeBytes, performanceBaseline.imageSizeBytes, tolerancePercent),
  ].filter((v): v is string => v !== null);

  return { ok: violations.length === 0, violations };
}

export function evaluateGate(
  live: { correctness: LiveCorrectness; speed: LiveSpeedPerformance; performance: LiveSpeedPerformance },
  baseline: GateBaseline,
): Verdict {
  const correctness = evaluateCorrectness(live.correctness, baseline.correctness);
  const speedPerformance = evaluateSpeedPerformance(
    { ...live.speed, ...live.performance },
    baseline.speed,
    baseline.performance,
    baseline.tolerancePercent,
  );
  return {
    ok: correctness.ok && speedPerformance.ok,
    violations: [...correctness.violations, ...speedPerformance.violations],
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([\w-]+)=(.*)$/.exec(arg);
    if (match && match[1] !== undefined && match[2] !== undefined) args[match[1]] = match[2];
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const baseline = JSON.parse(readFileSync(new URL('./gate-baseline.json', import.meta.url), 'utf8')) as GateBaseline;
  const packages = Object.keys(baseline.correctness.typecheck.byPackage);

  const eslintCounts = args['eslint-json'] ? parseEslintJson(readFileSync(args['eslint-json'], 'utf8')) : baseline.correctness.eslint;
  const typecheckCounts = args['typecheck-log']
    ? parseTypecheckOutput(readFileSync(args['typecheck-log'], 'utf8'), packages)
    : baseline.correctness.typecheck;

  const live = {
    correctness: { eslint: eslintCounts, typecheck: typecheckCounts },
    speed: { gateWallClockSeconds: args['wall-clock-seconds'] ? Number(args['wall-clock-seconds']) : undefined },
    performance: {
      runnerMinutes: args['runner-minutes'] ? Number(args['runner-minutes']) : undefined,
      imageSizeBytes: args['image-size-bytes'] ? Number(args['image-size-bytes']) : undefined,
    },
  };

  const verdict = evaluateGate(live, baseline);

  if (verdict.ok) {
    console.log('Gate guard: PASS — no new violations vs frozen baseline.');
  } else {
    console.error('Gate guard: FAIL — new violations vs frozen baseline:');
    for (const v of verdict.violations) console.error(`  - ${v}`);
  }

  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
