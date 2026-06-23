/**
 * Gated full-journey integration test (WS5) — Claude Agent SDK ↔ `toon-mcp`.
 *
 * Runs the in-package {@link runJourney} driver against a live testnet/devnet:
 * connect → socialfi → store → defi, asserting `result.passed === true` with
 * every step green (incl. the DeFi on-chain settlement assertion).
 *
 * This is testnet-only with treasury-tiny amounts; the live run needs
 * human-provisioned funds + secrets (see issue #28 "Human prerequisites").
 *
 * GATING — skips cleanly unless BOTH hold (so the default suite / CI never
 * needs a credential and the test stays `describe.skip`):
 *   • `RUN_MCP_USE_JOURNEY=1`, AND
 *   • a Claude credential is present (`CLAUDE_CODE_OAUTH_TOKEN`, Max-plan; or
 *     `ANTHROPIC_API_KEY`).
 *
 * NOTE: this test deliberately does NOT read `e2e/testnets.json` at
 * module-load time — the journey driver gets its testnet wiring from
 * `TOON_CLIENT_CONFIG`. So it collects + skips cleanly even when that fixture
 * is absent (unlike `live-hs-daemon.integration.test.ts`).
 *
 * Run:
 *   RUN_MCP_USE_JOURNEY=1 \
 *   CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
 *   TOON_CLIENT_MNEMONIC="word word word ..." \
 *   TOON_CLIENT_CONFIG=/path/to/testnet-config.json \
 *     pnpm --filter @toon-protocol/client-mcp test:integration
 */

import { describe, it, expect } from 'vitest';
import { runJourney } from '../e2e/journey-driver.js';

const RUN = process.env['RUN_MCP_USE_JOURNEY'] === '1';
const hasAuth =
  !!process.env['CLAUDE_CODE_OAUTH_TOKEN'] ||
  !!process.env['ANTHROPIC_API_KEY'];
const describeLive = RUN && hasAuth ? describe : describe.skip;

describeLive(
  'Claude agent journey (RUN_MCP_USE_JOURNEY=1 + Claude credential)',
  () => {
    const mnemonic = process.env['TOON_CLIENT_MNEMONIC'] ?? '';
    const configPath = process.env['TOON_CLIENT_CONFIG'] ?? '';
    const model = process.env['CLAUDE_MODEL'] ?? 'sonnet';

    it('has the required env configured', () => {
      expect(mnemonic, 'TOON_CLIENT_MNEMONIC').not.toBe('');
      expect(configPath, 'TOON_CLIENT_CONFIG').not.toBe('');
    });

    it('drives connect→socialfi→store→defi and every step passes', async () => {
      const result = await runJourney({
        mnemonic,
        configPath,
        model,
        mode: 'test',
      });

      // Every executed phase, in order.
      expect(result.steps.map((s) => s.phase)).toEqual([
        'connect',
        'socialfi',
        'store',
        'defi',
      ]);

      // Surface per-step failures with their transcript for triage.
      for (const step of result.steps) {
        expect(step.pass, `${step.phase}: ${step.transcript}`).toBe(true);
        if (step.assertion) {
          expect(
            step.assertion.ok,
            `${step.phase} ${step.assertion.kind} assertion: ${step.assertion.detail ?? ''}`
          ).toBe(true);
        }
      }

      expect(result.passed, 'aggregate journey verdict').toBe(true);
    });
  }
);
