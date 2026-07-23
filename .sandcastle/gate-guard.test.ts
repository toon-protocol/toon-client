import { describe, it, expect } from 'vitest';
import {
  parseEslintJson,
  parseTypecheckOutput,
  evaluateCorrectness,
  evaluateSpeedPerformance,
  evaluateGate,
} from './gate-guard.ts';

const baseline = {
  tolerancePercent: 20,
  correctness: {
    eslint: { errors: 16, warnings: 718 },
    typecheck: {
      totalErrors: 75,
      byPackage: { arweave: 0, client: 0, 'client-mcp': 0, rig: 1, 'rig-web': 74, views: 0 },
    },
  },
  speed: { gateWallClockSeconds: 185 },
  performance: { runnerMinutesEstimate: 3.08, imageSizeBytes: null },
};

describe('parseEslintJson', () => {
  it('sums errorCount and warningCount across files', () => {
    const json = JSON.stringify([
      { filePath: 'a.ts', errorCount: 2, warningCount: 1 },
      { filePath: 'b.ts', errorCount: 0, warningCount: 5 },
    ]);
    expect(parseEslintJson(json)).toEqual({ errors: 2, warnings: 6 });
  });

  it('returns zero counts for an empty report', () => {
    expect(parseEslintJson('[]')).toEqual({ errors: 0, warnings: 0 });
  });
});

describe('parseTypecheckOutput', () => {
  const log = [
    'Scope: 6 of 7 workspace projects',
    'packages/rig typecheck$ tsc -p tsconfig.json --noEmit',
    "packages/rig typecheck: src/cli/output.ts(281,45): error TS2345: Argument of type '...' is not assignable.",
    'packages/rig typecheck: Failed',
    'packages/rig-web typecheck$ tsc -p tsconfig.json --noEmit',
    "packages/rig-web typecheck: playwright.config.ts(5,24): error TS4111: Property 'CI' comes from an index signature.",
    "packages/rig-web typecheck:   The last overload gave the following error.",
    "packages/rig-web typecheck: src/web/blame.test.ts(170,20): error TS2339: Property 'lines' does not exist.",
    'packages/rig-web typecheck: Failed',
    'packages/client typecheck: Done',
  ].join('\n');

  it('counts error TS occurrences per package', () => {
    const result = parseTypecheckOutput(log, ['arweave', 'client', 'client-mcp', 'rig', 'rig-web', 'views']);
    expect(result.byPackage.rig).toBe(1);
    expect(result.byPackage['rig-web']).toBe(2);
  });

  it('does not count indented continuation lines without "error TS"', () => {
    const result = parseTypecheckOutput(log, ['rig-web']);
    // Only the 2 lines that actually contain "error TS" count, not the
    // "The last overload gave the following error." detail line.
    expect(result.byPackage['rig-web']).toBe(2);
  });

  it('reports zero for a listed package with no errors', () => {
    const result = parseTypecheckOutput(log, ['client']);
    expect(result.byPackage.client).toBe(0);
  });

  it('sums totalErrors across all packages', () => {
    const result = parseTypecheckOutput(log, ['arweave', 'client', 'client-mcp', 'rig', 'rig-web', 'views']);
    expect(result.totalErrors).toBe(3);
  });
});

describe('evaluateCorrectness', () => {
  const live = {
    eslint: { errors: 16, warnings: 718 },
    typecheck: { totalErrors: 75, byPackage: { arweave: 0, client: 0, 'client-mcp': 0, rig: 1, 'rig-web': 74, views: 0 } },
  };

  it('passes when live counts exactly match the frozen baseline', () => {
    expect(evaluateCorrectness(live, baseline.correctness).ok).toBe(true);
  });

  it('fails when eslint errors increase beyond baseline', () => {
    const result = evaluateCorrectness({ ...live, eslint: { errors: 17, warnings: 718 } }, baseline.correctness);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('eslint errors'))).toBe(true);
  });

  it('fails when eslint warnings increase beyond baseline', () => {
    const result = evaluateCorrectness({ ...live, eslint: { errors: 16, warnings: 719 } }, baseline.correctness);
    expect(result.ok).toBe(false);
  });

  it('passes when eslint counts improve (decrease) vs baseline', () => {
    const result = evaluateCorrectness({ ...live, eslint: { errors: 10, warnings: 700 } }, baseline.correctness);
    expect(result.ok).toBe(true);
  });

  it('fails when repo-wide typecheck totalErrors increases', () => {
    const result = evaluateCorrectness(
      { ...live, typecheck: { totalErrors: 76, byPackage: { ...live.typecheck.byPackage, rig: 2 } } },
      baseline.correctness,
    );
    expect(result.ok).toBe(false);
  });

  it('fails when a single package regresses even though the repo-wide total is unchanged', () => {
    // rig goes 1 -> 2, rig-web goes 74 -> 73: total stays 75, but debt moved
    // into a package that must not gain new errors.
    const result = evaluateCorrectness(
      { ...live, typecheck: { totalErrors: 75, byPackage: { ...live.typecheck.byPackage, rig: 2, 'rig-web': 73 } } },
      baseline.correctness,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('rig'))).toBe(true);
  });

  it('fails when a package with no baseline entry reports new errors', () => {
    const result = evaluateCorrectness(
      { ...live, typecheck: { totalErrors: 76, byPackage: { ...live.typecheck.byPackage, arweave: 1 } } },
      baseline.correctness,
    );
    expect(result.ok).toBe(false);
  });

  it('passes when typecheck counts improve (decrease) vs baseline', () => {
    const result = evaluateCorrectness(
      { ...live, typecheck: { totalErrors: 74, byPackage: { ...live.typecheck.byPackage, rig: 0 } } },
      baseline.correctness,
    );
    expect(result.ok).toBe(true);
  });
});

describe('evaluateSpeedPerformance', () => {
  it('passes when live wall-clock is within tolerance of the frozen baseline', () => {
    const result = evaluateSpeedPerformance(
      { gateWallClockSeconds: 200, runnerMinutes: 3.1 },
      baseline.speed,
      baseline.performance,
      baseline.tolerancePercent,
    );
    expect(result.ok).toBe(true);
  });

  it('fails when live wall-clock exceeds baseline + tolerance', () => {
    const result = evaluateSpeedPerformance(
      { gateWallClockSeconds: 230, runnerMinutes: 3.1 },
      baseline.speed,
      baseline.performance,
      baseline.tolerancePercent,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('wall-clock'))).toBe(true);
  });

  it('is not a violation exactly at the tolerance boundary', () => {
    const thresholdSeconds = 185 * 1.2; // 222
    const result = evaluateSpeedPerformance(
      { gateWallClockSeconds: thresholdSeconds, runnerMinutes: 3.08 },
      baseline.speed,
      baseline.performance,
      baseline.tolerancePercent,
    );
    expect(result.ok).toBe(true);
  });

  it('fails when runner-minutes exceeds baseline + tolerance', () => {
    const result = evaluateSpeedPerformance(
      { gateWallClockSeconds: 185, runnerMinutes: 4 },
      baseline.speed,
      baseline.performance,
      baseline.tolerancePercent,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('runner-minutes'))).toBe(true);
  });

  it('skips a metric with no frozen baseline value instead of fabricating a comparison', () => {
    const result = evaluateSpeedPerformance(
      { gateWallClockSeconds: 185, runnerMinutes: 3.08, imageSizeBytes: 999_999_999 },
      baseline.speed,
      baseline.performance, // imageSizeBytes is null
      baseline.tolerancePercent,
    );
    expect(result.ok).toBe(true);
  });
});

describe('evaluateGate', () => {
  it('combines correctness and speed/performance violations into a single verdict', () => {
    const live = {
      correctness: {
        eslint: { errors: 100, warnings: 718 },
        typecheck: baseline.correctness.typecheck,
      },
      speed: { gateWallClockSeconds: 185 },
      performance: { runnerMinutes: 3.08 },
    };
    const result = evaluateGate(live, baseline);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('passes clean when everything matches the frozen baseline', () => {
    const live = {
      correctness: baseline.correctness,
      speed: { gateWallClockSeconds: 185 },
      performance: { runnerMinutes: 3.08 },
    };
    const result = evaluateGate(live, baseline);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
