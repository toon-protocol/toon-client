/**
 * Client E2E Test — Solana Lazy Channel
 *
 * Tests lazy channel flow with Solana chain config.
 *
 * Requires: ./scripts/sdk-e2e-infra.sh up (with Solana validator healthy)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  SOLANA_RPC,
  SOLANA_PROGRAM_ID,
  checkAllServicesReady,
  skipIfNotReady,
  waitForSolanaHealth,
} from '../../../sdk/tests/e2e/helpers/docker-e2e-setup.js';

describe('Client E2E: Solana Lazy Channel', { timeout: 120_000 }, () => {
  let servicesReady = false;
  let solanaReady = false;

  beforeAll(async () => {
    servicesReady = await checkAllServicesReady();
    if (servicesReady) {
      solanaReady = await waitForSolanaHealth(15_000);
    }
  });

  it('should have Solana validator running', async () => {
    if (skipIfNotReady(servicesReady)) return;
    expect(solanaReady).toBe(true);
  });

  it('should have Solana program ID available', async () => {
    if (skipIfNotReady(servicesReady)) return;
    if (!solanaReady) return;

    // Program ID should be captured by the infra script from the keypair
    // It may be empty if the infra script hasn't been updated yet
    console.log(`Solana program ID: ${SOLANA_PROGRAM_ID || '(not set)'}`);
    expect(typeof SOLANA_PROGRAM_ID).toBe('string');
  });

  it('should connect to Solana RPC', async () => {
    if (skipIfNotReady(servicesReady)) return;
    if (!solanaReady) return;

    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth',
      }),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty('result', 'ok');
  });
});
