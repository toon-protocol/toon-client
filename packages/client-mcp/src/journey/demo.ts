/**
 * Capstone journey demo (#25): chain the merged SocialFi and DeFi journeys into
 * one ordered plan, run it against a `toon-clientd` daemon, print each step's
 * ViewSpec panel, and print the settlement receipt sourced from the `swap`
 * response joined with the `channels()` watermark.
 *
 * There is intentionally NO `settle()`/`toon_settle` step: the receipt is the
 * swap result (cumulative source/target + signed claims) reconciled against the
 * channel nonce watermark, exactly as `deFiJourney`'s `settlement-receipt` panel
 * already does. This module just chains the two existing journeys and renders
 * their output to stdout for the demo.
 *
 * Run from source (root devDep `tsx`):
 *   pnpm --filter @toon-protocol/client-mcp demo:journey
 * or against a built dist:
 *   node dist/journey/demo.js
 *
 * The daemon must already be running (toon-clientd). Live config + funding is a
 * human prerequisite (Base Sepolia treasury) and is OUT OF SCOPE for CI; the
 * dry-run unit test (`demo.test.ts`) covers the orchestration with a mocked
 * ControlClient and no network/funds.
 */

import type { ChannelsResponse, SwapResponse } from '../control-api.js';
import { ControlClient } from '../control-client.js';
import { runJourney } from './runner.js';
import { socialFiJourney } from './socialfi.js';
import { deFiJourney, type DeFiJourneyOpts } from './defi.js';
import type { JourneyPlan, JourneyResult } from './types.js';

/**
 * Concatenate several journey plans into one ordered plan. Step ids are
 * namespaced with the source plan id (`<planId>:<stepId>`) so the combined
 * `JourneyState` keys never collide when two legs reuse a step id.
 *
 * Note: each leg's `buildInput`/`renderPanel` reads its OWN step ids out of
 * `JourneyState`, so re-keying here would break that threading. We therefore
 * keep the original step ids on the steps themselves and only namespace the
 * combined plan's *reported* ids via a wrapper is unnecessary because the two
 * legs (`socialfi`, `defi`) share no step ids. We assert that invariant.
 */
export function chainJourneys(
  id: string,
  title: string,
  ...plans: JourneyPlan[]
): JourneyPlan {
  const steps = plans.flatMap((p) => p.steps);
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(
        `chainJourneys: duplicate step id "${step.id}" across chained plans — ` +
          `state threading requires unique step ids`
      );
    }
    seen.add(step.id);
  }
  return { id, title, steps };
}

/** Build the capstone SocialFi → DeFi plan. */
export function capstoneJourney(opts: {
  socialFi?: { pubkey?: string };
  deFi: DeFiJourneyOpts;
}): JourneyPlan {
  return chainJourneys(
    'capstone',
    'Capstone Journey: SocialFi → DeFi',
    socialFiJourney(opts.socialFi),
    deFiJourney(opts.deFi)
  );
}

/** The settlement receipt, derived from the swap response + channel watermark. */
export interface SettlementReceipt {
  accepted: boolean;
  state: SwapResponse['state'];
  cumulativeSource: string;
  cumulativeTarget: string;
  claims: SwapResponse['claims'];
  channels: ChannelsResponse['channels'];
}

/**
 * Reconstruct the settlement receipt from a completed journey result. Sources
 * the swap payload from the `swap` step's raw ToolResult and the channel
 * watermark from the `settlement-receipt` step's raw ToolResult. Returns
 * undefined if either step is missing (e.g. the run halted before DeFi).
 */
export function extractReceipt(result: JourneyResult): SettlementReceipt | undefined {
  const swapStep = result.steps.find((s) => s.stepId === 'swap');
  const channelsStep = result.steps.find((s) => s.stepId === 'settlement-receipt');
  if (!swapStep || !channelsStep) return undefined;

  const swap = parseToolText<SwapResponse>(swapStep.toolResult.content[0]?.text);
  const channelsRes = parseToolText<ChannelsResponse>(
    channelsStep.toolResult.content[0]?.text
  );
  if (!swap || !channelsRes) return undefined;

  return {
    accepted: swap.accepted,
    state: swap.state,
    cumulativeSource: swap.cumulativeSource,
    cumulativeTarget: swap.cumulativeTarget,
    claims: swap.claims ?? [],
    channels: channelsRes.channels,
  };
}

function parseToolText<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Minimal console surface so the runner is testable with a captured logger. */
export interface DemoLogger {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Run the capstone journey against a ControlClient, printing each step's panel
 * JSON and the final settlement receipt. Returns the process exit code: 0 on a
 * fully-completed journey, 1 if any step errored. Does no network I/O itself —
 * the ControlClient does. No funds move in the dry-run test (mocked client).
 */
export async function runCapstoneDemo(
  client: ControlClient,
  opts: { socialFi?: { pubkey?: string }; deFi: DeFiJourneyOpts },
  logger: DemoLogger = console
): Promise<number> {
  const plan = capstoneJourney(opts);
  logger.log(`\n=== ${plan.title} (${plan.steps.length} steps) ===\n`);

  const result = await runJourney(plan, client);

  for (const step of result.steps) {
    const viewSpec = step.panel.structuredContent?.['viewSpec'];
    logger.log(`--- panel: ${step.stepId} ---`);
    logger.log(JSON.stringify(viewSpec, null, 2));
  }

  if (!result.completed) {
    logger.error(
      `\n[capstone] FAILED at step "${result.error?.stepId}": ${result.error?.message}`
    );
    return 1;
  }

  const receipt = extractReceipt(result);
  logger.log('\n=== Settlement Receipt ===');
  logger.log(JSON.stringify(receipt, null, 2));
  logger.log(`\n[capstone] completed all ${result.steps.length} steps.`);
  return 0;
}

/**
 * CLI entry. Reads connection + DeFi opts from env and runs the demo against a
 * live daemon. See module header for the live-run prerequisites.
 *
 * Env:
 *   TOON_DAEMON_URL    daemon control API base URL (default http://127.0.0.1:8787)
 *   TOON_SWAP_DEST     swap ILP destination (e.g. g.proxy.swap)
 *   TOON_SWAP_AMOUNT   source-asset amount, micro-units (e.g. 1000000)
 *   TOON_SWAP_PUBKEY   swap peer 64-char hex Nostr pubkey
 *   TOON_CHAIN_RECIPIENT  payout address on the target chain
 *   TOON_SWAP_PAIR     JSON SwapPair ({ from, to, rate, ... })
 *   TOON_SOCIALFI_PUBKEY  optional: seed panel bind-queries before onboard surfaces it
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const baseUrl = env['TOON_DAEMON_URL'] ?? 'http://127.0.0.1:8787';

  const destination = env['TOON_SWAP_DEST'];
  const amount = env['TOON_SWAP_AMOUNT'];
  const swapPubkey = env['TOON_SWAP_PUBKEY'];
  const chainRecipient = env['TOON_CHAIN_RECIPIENT'];
  const pairRaw = env['TOON_SWAP_PAIR'];

  if (!destination || !amount || !swapPubkey || !chainRecipient || !pairRaw) {
    console.error(
      '[capstone] missing required env: TOON_SWAP_DEST, TOON_SWAP_AMOUNT, ' +
        'TOON_SWAP_PUBKEY, TOON_CHAIN_RECIPIENT, TOON_SWAP_PAIR are all required ' +
        'for the live DeFi leg. See the module header for the full env contract.'
    );
    return 2;
  }

  let pair: DeFiJourneyOpts['pair'];
  try {
    pair = JSON.parse(pairRaw) as DeFiJourneyOpts['pair'];
  } catch (e) {
    console.error(`[capstone] TOON_SWAP_PAIR is not valid JSON: ${String(e)}`);
    return 2;
  }

  const client = new ControlClient({ baseUrl });
  const socialFiPubkey = env['TOON_SOCIALFI_PUBKEY'];

  return runCapstoneDemo(client, {
    ...(socialFiPubkey ? { socialFi: { pubkey: socialFiPubkey } } : {}),
    deFi: { destination, amount, swapPubkey, chainRecipient, pair },
  });
}

// Run when invoked directly (tsx src/journey/demo.ts or node dist/journey/demo.js).
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /[/\\]journey[/\\]demo\.(ts|js|mjs)$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[capstone] fatal:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
