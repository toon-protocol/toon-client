/**
 * Gated Claude Agent SDK smoke test for the `toon-mcp` stdio server.
 *
 * Drives the FULL stack the way a Claude agent does: the Agent SDK launches
 * `toon-mcp` (which auto-spawns `toon-clientd`) under an isolated temp
 * `TOON_CLIENT_HOME` + a free `TOON_CLIENT_HTTP_PORT`. It then:
 *   1. lists the MCP tools the agent sees (must contain `mcp__toon__*`), and
 *   2. drives ONE read-only / chain-free tool (`toon_channels`) to completion.
 *
 * Read-only: no on-chain funds, no chain calls — only the daemon's local
 * control API state.
 *
 * GATING — skips cleanly unless BOTH hold (so the default suite / CI never
 * needs a credential and the test stays `describe.skip`):
 *   • `RUN_AGENT_SDK_E2E=1`, AND
 *   • a Claude credential is present (`CLAUDE_CODE_OAUTH_TOKEN` or
 *     `ANTHROPIC_API_KEY`).
 *
 * Run:
 *   RUN_AGENT_SDK_E2E=1 \
 *   CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
 *     pnpm --filter @toon-protocol/client-mcp test:integration
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  startDaemonHarness,
  DEV_MNEMONIC,
  type DaemonHarness,
} from '../e2e/harness.js';

const RUN = process.env['RUN_AGENT_SDK_E2E'] === '1';
const hasAuth =
  !!process.env['CLAUDE_CODE_OAUTH_TOKEN'] || !!process.env['ANTHROPIC_API_KEY'];
const describeLive = RUN && hasAuth ? describe : describe.skip;

describeLive(
  'Agent SDK ↔ toon-mcp smoke (RUN_AGENT_SDK_E2E=1 + Claude credential)',
  () => {
    let harness: DaemonHarness | undefined;

    afterAll(async () => {
      if (harness) {
        const { home } = harness;
        await harness.stop();
        // Teardown must leave no temp-home pollution behind.
        expect(existsSync(home)).toBe(false);
      }
    });

    it('lists mcp__toon__* tools and drives the read-only toon_channels tool', async () => {
      harness = await startDaemonHarness({ mnemonic: DEV_MNEMONIC });

      // 1. The agent must discover a non-empty set of toon tools from the
      //    system/init message (server status asserted 'connected' inside).
      const tools = await harness.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools).toContain('mcp__toon__toon_channels');

      // 2. Drive the read-only tool; it must be invoked and the run must succeed.
      const { called, result } = await harness.callReadOnlyTool('toon_channels');
      expect(called, 'agent invoked mcp__toon__toon_channels').toBe(true);
      expect(typeof result).toBe('string');
    });
  }
);
