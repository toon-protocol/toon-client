#!/usr/bin/env node
/**
 * `toon-journey` — the WS5 demo runtime. Drives the full SocialFi + DeFi
 * journey headlessly via the Claude Agent SDK against the `toon-mcp` tools
 * (see {@link runJourney}) and prints a per-step PASS/FAIL summary, exiting
 * non-zero on any failure. Mirrors the standalone `journey/runner.mjs`.
 *
 * Auth is inherited from the environment: the Agent SDK spawns the bundled
 * Claude Code CLI, which reads `CLAUDE_CODE_OAUTH_TOKEN` (the org's Max-plan
 * token) — NOT a raw `ANTHROPIC_API_KEY`.
 *
 * Env:
 *   CLAUDE_CODE_OAUTH_TOKEN  (required) Max-plan auth.
 *   TOON_CLIENT_MNEMONIC     (required) seed the daemon derives its wallet from.
 *   TOON_CLIENT_CONFIG       (required) path to the client config.json (testnet).
 *   CLAUDE_MODEL             (optional) default "sonnet".
 *   TOON_JOURNEY             smoke | full   (default: smoke).
 *                            smoke == connect-only; full == all four phases.
 *   TOON_JOURNEY_MAX_TURNS   (optional) per-phase agent turn cap (default 30).
 */

import {
  runJourney,
  type JourneyPhaseName,
  type JourneyStep,
} from './journey-driver.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[journey] ${name} is required`);
    process.exit(2);
  }
  return v;
}

function phasesFor(mode: string): JourneyPhaseName[] {
  // smoke == connect only (no spend); full == the entire journey.
  return mode === 'full'
    ? ['connect', 'socialfi', 'store', 'defi']
    : ['connect'];
}

async function main(): Promise<void> {
  requireEnv('CLAUDE_CODE_OAUTH_TOKEN');
  const mnemonic = requireEnv('TOON_CLIENT_MNEMONIC');
  const configPath = requireEnv('TOON_CLIENT_CONFIG');

  const model = process.env['CLAUDE_MODEL'] ?? 'sonnet';
  const mode = process.env['TOON_JOURNEY'] ?? 'smoke';
  const phases = phasesFor(mode);
  const maxTurnsRaw = process.env['TOON_JOURNEY_MAX_TURNS'];
  const maxTurns = maxTurnsRaw ? Number(maxTurnsRaw) : undefined;

  console.log(
    `[journey] mode=${mode} model=${model} phases=${phases.join(',')}`
  );

  const result = await runJourney({
    mnemonic,
    configPath,
    model,
    maxTurns,
    mode: 'demo',
    phases,
    onStep: (s: JourneyStep) => {
      const verdict = s.pass ? 'PASS' : 'FAIL';
      let line = `[journey] ${verdict}  ${s.phase}`;
      if (s.assertion) {
        line += `  (${s.assertion.kind} assertion ${s.assertion.ok ? 'ok' : 'FAILED'}`;
        if (s.assertion.detail) line += `: ${s.assertion.detail}`;
        line += ')';
      }
      console.log(line);
      if (s.transcript.trim()) {
        console.log(
          s.transcript
            .trim()
            .split('\n')
            .map((l) => `    | ${l}`)
            .join('\n')
        );
      }
    },
  });

  console.log('\n========== journey summary ==========');
  for (const s of result.steps) {
    console.log(`  ${s.pass ? 'PASS' : 'FAIL'}  ${s.phase}`);
  }
  const failed = result.steps.filter((s) => !s.pass);
  if (failed.length > 0 || !result.passed) {
    console.error(
      `[journey] ${failed.length}/${result.steps.length} phase(s) failed`
    );
    process.exit(1);
  }
  console.log(`[journey] all ${result.steps.length} phase(s) passed`);
}

main().catch((err: unknown) => {
  console.error('[journey] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
